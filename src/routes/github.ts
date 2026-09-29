import { Elysia } from "elysia"
import {
  clearGitLinkage,
  deleteInstallation,
  getGithubApp,
  getWebhookSecret,
  resourcesForPush,
  upsertInstallation,
} from "../db/queries.ts"
import { forgetInstallation } from "../github/repos.ts"
import {
  shouldSkipPush,
  verifySignature,
  WEBHOOK_PATH,
} from "../github/webhook.ts"
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
  /** The commit the push moved the branch to. */
  after?: unknown
  deleted?: unknown
  repository?: { full_name?: unknown }
  /** Unvalidated payload; only shouldSkipPush reads it. Never logged — a
   *  commit message is user text and may hold anything. */
  commits?: unknown
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

  // Only a full lowercase SHA-1 is compared against what a running deploy
  // fetched; anything else — absent, abbreviated, another hash format — skips
  // that check, so the push is handled exactly as before rather than dropped.
  // An all-zeros SHA passes the pattern but no fetched commit is all zeros, so
  // it never matches and the push is queued as before.
  const after =
    typeof body.after === "string" && /^[0-9a-f]{40}$/.test(body.after)
      ? body.after
      : null

  const affected = resourcesForPush(repo, branch)
  logger.info(
    { delivery, repo, branch, resources: affected.length },
    "push received",
  )

  if (affected.length > 0 && shouldSkipPush(body.commits)) {
    logger.info(
      {
        delivery,
        repo,
        branch,
        commits: Array.isArray(body.commits) ? body.commits.length : 0,
        resources: affected.length,
      },
      "push skipped: every commit asks to skip deploys ([skip ci])",
    )
    return
  }

  for (const resource of affected) {
    const result = enqueueDeployCoalesced(resource.id, after)
    if (result.outcome === "folded") {
      logger.info(
        { resourceId: resource.id, repo, branch },
        "push folded into a deploy of this resource that has not started yet",
      )
    } else if (result.outcome === "running") {
      logger.info(
        {
          resourceId: resource.id,
          repo,
          branch,
          deploymentId: result.deploymentId,
          commit: after,
        },
        "push skipped: a deploy of this commit is already running",
      )
    }
  }
}

/**
 * Synchronous on purpose: every branch is a SQLite write or a cache delete, so
 * the 202 goes back well inside GitHub's 10-second delivery timeout.
 */
function handleInstallation(body: InstallationEvent): void {
  const installationId = body.installation?.id
  if (typeof installationId !== "number") return

  const action = body.action
  if (action === "deleted") {
    // The same cleanup as a sync that finds the installation gone
    // (register.ts): unlink first, because resources.git_installation_id has
    // no foreign key and would otherwise hold an id that 404s at the next
    // deploy. The repo and branch stay — only the credential is gone, and
    // the user can re-link from the resource's settings. The column holds
    // GitHub's integer as a decimal string.
    const unlinked = clearGitLinkage(String(installationId))
    deleteInstallation(installationId)
    forgetInstallation(installationId)
    logger.info(
      { installationId, action, unlinked },
      "installation deleted on GitHub",
    )
    return
  }

  if (action === "suspend") {
    // The row and every resource link are KEPT. A suspension is reversible on
    // GitHub's side, and keeping them is what lets `unsuspend` restore deploys
    // with no action here. Only the cached token and repository list go:
    // GitHub has revoked the token, and handing it out until its hour ends
    // would fail every call.
    forgetInstallation(installationId)
    logger.info(
      { installationId, action },
      "installation suspended; its resource links are kept",
    )
    return
  }

  // Any other action (created, unsuspend, new_permissions_accepted) means the
  // installation exists and its login may have changed. A cached token was
  // minted under the previous permissions or before a suspension, so it is
  // dropped (with the cached repository list) and the next call mints one
  // under the current terms.
  forgetInstallation(installationId)
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
  WEBHOOK_PATH,
  async ({ request, set }) => {
    // Order below is load-bearing: raw bytes, then secret, then signature, and
    // only then a parse. GitHub signs the bytes it sent, so anything that
    // re-serializes the body before verification breaks every delivery.
    const raw = await request.text()
    const event = request.headers.get("x-github-event")
    const delivery = request.headers.get("x-github-delivery")

    const secret = getWebhookSecret()
    if (!secret) {
      // 202 rather than an error: no redelivery can fix "musdash has no GitHub
      // App registered", and GitHub never redelivers on its own anyway — a
      // non-2xx only marks the delivery failed under the App's Recent
      // Deliveries.
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
      case "installation_repositories": {
        // A token is scoped to the grant it was minted under, and the cached
        // repository list no longer matches the grant either.
        // forgetInstallation drops both, so the next picker render refetches
        // the list under the new grant. A syncInstallations() here would still
        // put a GitHub round trip inside a request GitHub times out at 10
        // seconds.
        const installationId = (body as InstallationEvent).installation?.id
        if (typeof installationId === "number")
          forgetInstallation(installationId)
        logger.info({ delivery }, "installation repositories changed")
        break
      }
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
