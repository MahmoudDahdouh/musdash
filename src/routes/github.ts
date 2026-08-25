import { Elysia } from "elysia"
import {
  deleteInstallation,
  getGithubApp,
  getWebhookSecret,
  resourceImage,
  resourcesForPush,
  upsertInstallation,
} from "../db/queries.ts"
import { verifySignature } from "../github/webhook.ts"
import { enqueueDeployCoalesced } from "../jobs/deploy.ts"
import { logger } from "../log.ts"

/**
 * The inbound GitHub webhook, on its own Elysia instance.
 *
 * This is NOT part of appRoutes and must never be moved there. That instance
 * redirects an unauthenticated POST to /login with a 303, and GitHub records
 * any 2xx or 3xx as a SUCCESSFUL delivery and never retries. Mounting the
 * webhook behind the session guard would therefore produce the worst possible
 * failure: the deliveries page all green, auto-deploy apparently configured,
 * and nothing ever deploying.
 *
 * Elysia 1.4 hooks are `local`-scoped by default and this codebase declares no
 * global or scoped hooks anywhere, so a sibling instance is genuinely outside
 * that guard. Adding a global scope somewhere would silently pull this route
 * back under it.
 *
 * Its authentication is the HMAC signature, which is why this route is the one
 * deliberate exception to "CSRF on every state-changing POST".
 */

const REF_PREFIX = "refs/heads/"

interface PushEvent {
  ref?: unknown
  deleted?: unknown
  repository?: { full_name?: unknown }
}

interface InstallationEvent {
  action?: unknown
  installation?: { id?: unknown; account?: { login?: unknown } }
}

/** The branch a push ref names, or null for a tag or anything else. */
function branchFromRef(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) return null
  const branch = ref.slice(REF_PREFIX.length)
  return branch.length > 0 ? branch : null
}

function handlePush(body: PushEvent, delivery: string | null): void {
  const branch = branchFromRef(body.ref)
  // A tag push, or a ref shape we do not handle. Not an error.
  if (branch === null) return

  // A branch deletion is not a reason to redeploy the branch that no longer
  // exists — the tip it names is gone and the build would fail.
  if (body.deleted === true) return

  const repo = body.repository?.full_name
  if (typeof repo !== "string" || repo.length === 0) return

  const affected = resourcesForPush(repo, branch)
  logger.info(
    { delivery, repo, branch, resources: affected.length },
    "push received",
  )

  for (const resource of affected) {
    // A git resource has no image until it has built one; the placeholder only
    // labels the row until the build resolves the real tag.
    const deploymentId = enqueueDeployCoalesced(
      resource.id,
      resourceImage(resource) || "(building)",
    )
    if (deploymentId === null) {
      logger.info(
        { resourceId: resource.id, repo, branch },
        "push coalesced into a deploy already queued this minute",
      )
    }
  }
}

function handleInstallation(body: InstallationEvent): void {
  const installationId = body.installation?.id
  if (typeof installationId !== "number") return

  const action = body.action
  if (action === "deleted" || action === "suspend") {
    deleteInstallation(installationId)
    logger.info({ installationId, action }, "installation removed")
    return
  }

  // Any other action (created, unsuspend, new_permissions_accepted) means the
  // installation exists and its login may have changed.
  const app = getGithubApp()
  if (!app) return
  const login = body.installation?.account?.login
  if (typeof login !== "string") return

  // appRowId is the APP's ULID, not the installation's id and not GitHub's
  // number. Three different values, and the wrong one fails as a 404 from
  // GitHub at deploy time rather than here.
  upsertInstallation({
    appRowId: app.id,
    installationId,
    accountLogin: login,
  })
}

export const githubWebhookRoutes = new Elysia().post(
  "/webhooks/github",
  async ({ request, set }) => {
    // Order below is load-bearing: raw bytes, then secret, then signature, and
    // only then a parse. GitHub signs the bytes it sent, so anything that
    // re-serializes the body before verification breaks every delivery.
    const raw = await request.text()
    const event = request.headers.get("x-github-event")
    const delivery = request.headers.get("x-github-delivery")

    const secret = getWebhookSecret()
    if (!secret) {
      // 202, not an error: GitHub retries a non-2xx forever, and "musdash is
      // not connected to GitHub" is not something a retry can fix.
      logger.warn(
        { event, delivery },
        "webhook delivery ignored — no GitHub App is registered",
      )
      set.status = 202
      return "ignored"
    }

    if (
      !verifySignature(raw, request.headers.get("x-hub-signature-256"), secret)
    ) {
      // Log the delivery identity and nothing else. The body of an unverified
      // request is attacker-controlled and must not reach a log line.
      logger.warn({ event, delivery }, "webhook signature verification failed")
      set.status = 401
      return "invalid signature"
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      logger.warn({ event, delivery }, "webhook body was not valid JSON")
      set.status = 400
      return "invalid payload"
    }

    switch (event) {
      case "ping":
        logger.info({ delivery }, "webhook ping received")
        break
      case "push":
        handlePush(body as PushEvent, delivery)
        break
      case "installation":
        handleInstallation(body as InstallationEvent)
        break
      case "installation_repositories":
        // Deliberately nothing beyond a log. The repository list is re-fetched
        // every time the picker renders, so there is no local copy to keep in
        // sync — and a syncInstallations() here would put a GitHub round trip
        // inside a request GitHub times out at 10 seconds.
        logger.info({ delivery }, "installation repositories changed")
        break
      default:
        logger.debug({ event, delivery }, "webhook event ignored")
    }

    // Always 202 on the verified path, without awaiting anything slow. Every
    // handler above enqueues or writes SQLite; none of them touches Docker.
    set.status = 202
    return "accepted"
  },
  // parse:"none" is what makes `await request.text()` yield the raw bytes.
  // Verified against Elysia 1.4.29: a lone "none" parser sets `requestNoBody`
  // in the compiler, so the framework never reads the stream. Without it the
  // body is consumed before the handler runs and request.clone() throws
  // ERR_BODY_ALREADY_USED (the same trap app.ts records for CSRF).
  { parse: "none" },
)
