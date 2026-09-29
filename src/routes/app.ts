import { Elysia, t } from "elysia"
import { resolveSession, SESSION_COOKIE, verifyCsrf } from "../auth.ts"
import { isValidHostname } from "../caddy/client.ts"
import { config } from "../config.ts"
import { randomToken, safeEqual } from "../crypto.ts"
import { isValidImageRef, isValidResourceName } from "../docker/client.ts"
import {
  addDomain,
  clearGitLinkage,
  createEnvironment,
  createProject,
  createGitResource,
  createResource,
  deleteDomain,
  deleteGithubApp,
  deleteSetting,
  domainExists,
  findResourceByNameInEnv,
  getDeployment,
  getEnvironment,
  getGithubApp,
  getProject,
  getEnvText,
  getResourceContext,
  getSetting,
  getSharedEnvText,
  latestDeploymentStatus,
  listAllResources,
  listDeployments,
  listDomains,
  listEnvironments,
  listGithubInstallations,
  listProjects,
  listResources,
  listSharedEnvKeys,
  recentDeployments,
  resolveEnvKeys,
  resourceImage,
  setAutoDeploy,
  setEnvVars,
  setGitSource,
  setResourceImage,
  setSetting,
  setSharedEnvVars,
  updateEnvironment,
  updateProject,
  updateResource,
  type EnvVarInput,
} from "../db/queries.ts"
import { parseEnvText } from "../env/parse.ts"
import { deployLogTail } from "../events.ts"
import { isFullCommitSha } from "../github/api.ts"
import { buildManifest, ManifestError } from "../github/manifest.ts"
import {
  convertManifestCode,
  replaceGithubApp,
  syncInstallations,
} from "../github/register.ts"
import { cachedInstallationRepos, clearGitHubCaches } from "../github/repos.ts"
import { flashFromQuery, settingsViewModel } from "../github/settings.ts"
import { BUILD_PLACEHOLDER } from "../build/images.ts"
import {
  cancelQueuedDeploy,
  enqueueDeploy,
  enqueueRedeploy,
  pendingDeploymentFor,
  redeployable,
} from "../jobs/deploy.ts"
import { logger } from "../log.ts"
import { tail } from "../logs/buffer.ts"
import { enqueue, findLeasedJobs, findPendingJob } from "../queue/index.ts"
import {
  requestRestart,
  restartBlockedReason,
  restartCapability,
} from "../restart.ts"
import { resourceState } from "../resource-state.ts"
import { dashboardHostView } from "../settings-view.ts"
import {
  getDashboardHost,
  getPublicIp,
  getPublicUrl,
  SETTING_GITHUB_MANIFEST_STATE,
  SETTING_PUBLIC_IP,
  setDashboardHost,
  setPublicIp,
} from "../settings.ts"
import { renderPage } from "../views/render.ts"
import { assignAutoDomain, autoDomainBase } from "../domains/auto.ts"
import { isPublicIPv4 } from "../domains/generate.ts"
import { parseContainerPort } from "./container-port.ts"
import { errorKeyFromQuery, withError } from "./errors.ts"
import { checkGitSource } from "./git-source.ts"
import { layout, statusFor } from "./layout.ts"
import { isValidDisplayName, normalizeDisplayName } from "../names.ts"

const html = (body: string, headers?: Record<string, string>) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  })

/**
 * For the two pages whose Variables tab renders decrypted values into the
 * edit boxes: keeps that HTML out of the browser's disk cache. Every other
 * page is value-free and keeps the default.
 */
const NO_STORE = { "cache-control": "no-store" }

/**
 * Escapes text for an HTML attribute.
 *
 * Used only by the self-submitting manifest form, whose `manifest` value is
 * JSON full of quotes. Eta autoescapes everywhere else; this one document is
 * built by hand, so it escapes by hand.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/**
 * A redirect target for /settings carrying a one-shot message.
 *
 * In the query string rather than a server-side flash store: no per-session
 * state to hold, and nothing to clean up if the user never follows the
 * redirect. Free text, unlike the keyed errors of D37 — moving these to keys
 * is a recorded follow-up.
 */
function flashUrl(kind: "ok" | "error", text: string): string {
  return `/settings?flash=${kind}&msg=${encodeURIComponent(text)}`
}

/**
 * Turns whatever the operator pasted into a bare hostname.
 *
 * They will paste `https://mus.example.com/` at least as often as they type the
 * name, and rejecting that is a worse experience than accepting it. Strips a
 * scheme, any path, a port and a trailing dot, then lowercases. Empty means
 * "no dashboard host".
 */
function normalizeHost(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .toLowerCase()
}

/**
 * Whether a remove_project or remove_environment job is waiting or running for
 * this parent — the page says "being deleted" until the job is done, which a
 * running build ahead of it can delay by minutes (D67).
 */
function removalQueued(
  type: "remove_project" | "remove_environment",
  fields: Record<string, string>,
): boolean {
  return (
    findPendingJob(type, fields) !== null ||
    findLeasedJobs(type, fields).length > 0
  )
}

/** The three scoped textareas every env form posts. */
const envBody = t.Object({
  runtime: t.Optional(t.String()),
  build: t.Optional(t.String()),
  both: t.Optional(t.String()),
  csrf: t.String(),
})

/**
 * Parses the three scoped textareas into one flat list.
 *
 * A key appearing in two boxes is an ERROR rather than a last-wins merge: the
 * boxes are one logical set split by presentation, so the same key in two of
 * them means the user believes they are two different variables. Silently
 * keeping one is how a build gets a value nobody can account for.
 *
 * The result is a key, not parseEnvText's messages: those quote the rejected
 * line, and a rejected line is usually a secret. They must never reach a URL,
 * a page or a log, so they are dropped here rather than filtered later. A bad
 * line wins over a cross-box duplicate — it is the one to fix first.
 */
function parseScopedEnv(body: {
  runtime?: string
  build?: string
  both?: string
}): {
  vars: EnvVarInput[]
  error: "env-invalid-line" | "env-scope-duplicate" | null
} {
  const vars: EnvVarInput[] = []
  let invalidLine = false
  let duplicate = false
  const seen = new Set<string>()
  for (const scope of ["runtime", "build", "both"] as const) {
    const parsed = parseEnvText(body[scope] ?? "")
    if (parsed.errors.length > 0) invalidLine = true
    for (const [key, value] of Object.entries(parsed.vars)) {
      if (seen.has(key)) {
        duplicate = true
        continue
      }
      seen.add(key)
      vars.push({ key, value, scope })
    }
  }
  const error = invalidLine
    ? "env-invalid-line"
    : duplicate
      ? "env-scope-duplicate"
      : null
  return { vars, error }
}

/**
 * Session + CSRF gate.
 *
 * CSRF is enforced globally for every state-changing method rather than
 * per-route. An opt-in scheme fails silently on the one route someone forgets
 * to annotate, which is exactly the route an attacker will find.
 */
export const appRoutes = new Elysia()
  .derive(({ cookie }) => {
    const raw = cookie[SESSION_COOKIE]?.value
    const session = resolveSession(typeof raw === "string" ? raw : undefined)
    return { session }
  })
  .onBeforeHandle(({ session, path, request, redirect }) => {
    if (!session) {
      return path.startsWith("/api") || path.includes("/events")
        ? new Response("unauthorized", { status: 401 })
        : redirect("/login", 303)
    }
    void request
  })
  .onBeforeHandle(({ session, request, body, path }) => {
    if (request.method === "GET" || request.method === "HEAD") return
    if (!session) return new Response("unauthorized", { status: 401 })

    // Read the token from the parsed body, not from request.clone(): Elysia has
    // already consumed the stream by this point, so cloning here throws
    // ERR_BODY_ALREADY_USED and every POST 500s.
    const token = (body as { csrf?: unknown } | undefined)?.csrf
    if (!verifyCsrf(session, token)) {
      logger.warn({ path }, "CSRF check failed")
      return statusFor(session, 403)
    }
  })

  // ------------------------------------------------------------- projects

  /**
   * Home (D69): what is happening across every project — deploys in flight,
   * the latest deployments, and how many resources are in each state. Reads
   * only SQLite, like every page.
   */
  .get("/", ({ session }) => {
    const projects = listProjects()
    const states: Record<string, number> = {}
    let resourceCount = 0
    for (const resource of listAllResources()) {
      resourceCount++
      const state = resourceState(resource, latestDeploymentStatus(resource.id))
      states[state] = (states[state] ?? 0) + 1
    }
    const recent = recentDeployments(10).map((d) => ({
      ...d,
      duration: formatDuration(d.startedAt, d.finishedAt),
    }))
    // The toast's list, read once for both the page and the layout.
    const frame = layout(session, "Home", { section: "home" })
    return html(
      renderPage(
        "home",
        {
          projectCount: projects.length,
          resourceCount,
          states,
          active: frame.active ?? [],
          recent,
        },
        frame,
      ),
    )
  })

  .get("/projects", ({ session }) => {
    const projects = listProjects().map((project) => {
      const envs = listEnvironments(project.id)
      return {
        project,
        environmentCount: envs.length,
        resourceCount: envs.reduce((n, e) => n + listResources(e.id).length, 0),
      }
    })
    return html(
      renderPage(
        "projects",
        { projects, csrf: session?.csrfToken },
        layout(session, "Projects", { section: "projects" }),
      ),
    )
  })

  .post(
    "/projects",
    ({ body, redirect, session }) => {
      // The form's pattern mirrors this, so a refusal is a hand-made request.
      const name = normalizeDisplayName(body.name)
      if (!isValidDisplayName(name)) return statusFor(session, 400)
      const project = createProject(name, body.description?.trim())
      return redirect(`/p/${project.id}`, 303)
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 200 })),
        csrf: t.String(),
      }),
    },
  )

  .get("/p/:projectId", async ({ params, query, session }) => {
    const project = getProject(params.projectId)
    if (!project) return statusFor(session, 404)

    const tab = ["resources", "env", "settings"].includes(String(query.tab))
      ? String(query.tab)
      : "resources"

    // Decrypted only on the env tab, the one place the values render.
    const showEnv = tab === "env"

    const environments = listEnvironments(project.id).map((environment) => ({
      environment,
      // A delete was pressed and the job has not run yet — usually a second,
      // longer behind a running build (D67).
      deleting: removalQueued("remove_environment", {
        environmentId: environment.id,
      }),
      sharedEnv: listSharedEnvKeys({ environmentId: environment.id }),
      envText: showEnv
        ? getSharedEnvText({ environmentId: environment.id })
        : undefined,
      resources: listResources(environment.id).map((resource) => ({
        resource,
        image: resourceImage(resource),
        // One query per resource, like domainCount: a project page holds a
        // handful.
        // Cancelled rows are skipped there and here alike (D59).
        state: resourceState(resource, latestDeploymentStatus(resource.id)),
        domainCount: listDomains(resource.id).length,
      })),
    }))

    return html(
      renderPage(
        "project",
        {
          project,
          environments,
          tab,
          deleting: removalQueued("remove_project", { projectId: project.id }),
          projectEnv: listSharedEnvKeys({ projectId: project.id }),
          envText: showEnv
            ? getSharedEnvText({ projectId: project.id })
            : undefined,
          csrf: session?.csrfToken,
          defaultMemoryMb: config.defaultMemoryMb,
          // Only on the resources tab: on a cache miss gitPicker makes one
          // GitHub API call per installation, and the env tab renders none of
          // it.
          gitPicker:
            tab === "resources"
              ? await gitPicker()
              : { connected: false, installations: [] },
        },
        layout(session, project.name, {
          activeProjectId: project.id,
          errorKey: errorKeyFromQuery(query.error),
        }),
      ),
      showEnv ? NO_STORE : undefined,
    )
  })

  .post(
    "/p/:projectId/environments",
    ({ params, body, redirect, session }) => {
      if (!getProject(params.projectId)) return statusFor(session, 404)
      if (!isValidResourceName(body.name)) return statusFor(session, 400)
      // Checked before the insert: (project_id, name) is UNIQUE, and letting
      // the constraint refuse it surfaced as a 500.
      if (
        listEnvironments(params.projectId).some((e) => e.name === body.name)
      ) {
        return redirect(
          withError(`/p/${params.projectId}`, "env-name-taken"),
          303,
        )
      }
      createEnvironment(params.projectId, body.name)
      return redirect(`/p/${params.projectId}`, 303)
    },
    { body: t.Object({ name: t.String(), csrf: t.String() }) },
  )

  /** Renames a project and edits its description. Touches nothing but the row. */
  .post(
    "/p/:projectId/settings",
    ({ params, body, redirect, session }) => {
      const project = getProject(params.projectId)
      if (!project) return statusFor(session, 404)
      // The form's pattern mirrors this, so a refusal is a hand-made request.
      const name = normalizeDisplayName(body.name)
      if (!isValidDisplayName(name)) return statusFor(session, 400)
      updateProject(project.id, {
        name,
        description: body.description?.trim() || null,
      })
      return redirect(`/p/${project.id}?tab=settings`, 303)
    },
    {
      body: t.Object({
        name: t.String({ maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 200 })),
        csrf: t.String(),
      }),
    },
  )

  /**
   * Deletes a project and everything in it — on the queue, which tears down
   * each resource before any row goes (D67). The typed name is the one check
   * the form cannot make for itself.
   */
  .post(
    "/p/:projectId/delete",
    ({ params, body, redirect, session }) => {
      const project = getProject(params.projectId)
      if (!project) return statusFor(session, 404)
      // Both sides normalized: a name saved before D65 may hold a double space
      // that nobody could otherwise type back exactly.
      if (
        normalizeDisplayName(body.confirm) !==
        normalizeDisplayName(project.name)
      ) {
        return redirect(
          withError(`/p/${project.id}?tab=settings`, "project-confirm"),
          303,
        )
      }
      if (!findPendingJob("remove_project", { projectId: project.id })) {
        enqueue("remove_project", { projectId: project.id })
      }
      return redirect("/projects", 303)
    },
    {
      body: t.Object({
        confirm: t.String({ maxLength: 200 }),
        csrf: t.String(),
      }),
    },
  )

  /**
   * Renames an environment. Nothing outside the row reads the name any more:
   * automatic hostnames are stored rows, not recomputed from it (D66).
   */
  .post(
    "/e/:environmentId/settings",
    ({ params, body, redirect, session }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return statusFor(session, 404)
      if (!isValidResourceName(body.name)) return statusFor(session, 400)
      const back = `/p/${environment.projectId}`
      if (
        body.name !== environment.name &&
        listEnvironments(environment.projectId).some(
          (e) => e.name === body.name,
        )
      ) {
        return redirect(withError(back, "env-name-taken"), 303)
      }
      updateEnvironment(environment.id, { name: body.name })
      return redirect(`${back}#env-${environment.id}`, 303)
    },
    { body: t.Object({ name: t.String(), csrf: t.String() }) },
  )

  /** Deletes an environment and its resources, on the queue (D67). */
  .post(
    "/e/:environmentId/delete",
    ({ params, redirect, session }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return statusFor(session, 404)
      if (
        !findPendingJob("remove_environment", {
          environmentId: environment.id,
        })
      ) {
        enqueue("remove_environment", { environmentId: environment.id })
      }
      return redirect(`/p/${environment.projectId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  // ------------------------------------------------------------ resources

  .post(
    "/e/:environmentId/resources",
    ({ params, body, redirect, session }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return statusFor(session, 404)

      // The name is display text; the slug derived from it is what reaches
      // image tags and DNS labels (D65). Images can reach a shell. The name
      // field's pattern already refuses a bad name, so reaching this is a
      // hand-made request: a status page, not a notice.
      const name = normalizeDisplayName(body.name)
      if (!isValidDisplayName(name)) return statusFor(session, 400)
      // Blank means "no port". The input's min/max refuses an out-of-range
      // value, so a refusal here is almost always a hand-made request; the
      // rare browser-valid spelling it also refuses (80.0, 1e3) gets the same
      // status page.
      const containerPort = parseContainerPort(body.containerPort)
      if (!containerPort.ok) return statusFor(session, 400)
      const back = `/p/${environment.projectId}`
      if (!isValidImageRef(body.image)) {
        return redirect(withError(back, "image-invalid"), 303)
      }
      if (findResourceByNameInEnv(environment.id, name)) {
        return redirect(withError(back, "resource-name-taken"), 303)
      }

      const resource = createResource({
        environmentId: environment.id,
        name,
        image: body.image,
        containerPort: containerPort.port,
        healthPath: body.healthPath?.trim() || null,
        memoryLimitMb: body.memoryLimitMb ?? config.defaultMemoryMb,
      })

      // Give it its automatic hostname up front, so deploying is one click.
      assignAutoDomain(resource.id)

      return redirect(`/r/${resource.id}`, 303)
    },
    {
      body: t.Object({
        name: t.String(),
        image: t.String(),
        // A string, not Numeric: an empty number input submits "". See
        // container-port.ts.
        containerPort: t.Optional(t.String()),
        healthPath: t.Optional(t.String()),
        memoryLimitMb: t.Optional(t.Numeric()),
        csrf: t.String(),
      }),
    },
  )

  /**
   * A resource built from a repository.
   *
   * The installation, repo and branch rules live in checkGitSource, shared
   * with the re-link route below; see git-source.ts for why the rules differ
   * with and without an installation.
   */
  .post(
    "/e/:environmentId/resources/git",
    ({ params, body, redirect, session }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return statusFor(session, 404)

      const name = normalizeDisplayName(body.name)
      if (!isValidDisplayName(name)) return statusFor(session, 400)
      const containerPort = parseContainerPort(body.containerPort)
      if (!containerPort.ok) return statusFor(session, 400)
      const back = `/p/${environment.projectId}`
      if (findResourceByNameInEnv(environment.id, name)) {
        return redirect(withError(back, "resource-name-taken"), 303)
      }
      const source = checkGitSource(body)
      if (!source.ok) {
        switch (source.refusal) {
          // The repo input is hidden and filled by the picker, so it cannot be
          // `required` — this is the check the form cannot make.
          case "no-repo":
            return redirect(withError(back, "repo-required"), 303)
          case "bad-branch":
            return redirect(withError(back, "branch-invalid"), 303)
          // The picker only offers known installations and real repositories,
          // so only a stale tab or a hand-made request reaches these.
          case "bad-installation":
          case "bad-repo":
            return statusFor(session, 400)
        }
      }
      const { repo, branch, installationId } = source

      const resource = createGitResource({
        environmentId: environment.id,
        name,
        repo,
        branch,
        // Empty means "detect at build time" — the value is only read when the
        // user has made an explicit choice.
        pack: body.pack === "dockerfile" ? "dockerfile" : "railpack",
        dockerfilePath: body.dockerfilePath?.trim() || null,
        buildContext: body.buildContext?.trim() || null,
        installationId,
        containerPort: containerPort.port,
        healthPath: body.healthPath?.trim() || null,
        memoryLimitMb: body.memoryLimitMb ?? config.defaultMemoryMb,
      })

      assignAutoDomain(resource.id)

      return redirect(`/r/${resource.id}`, 303)
    },
    {
      body: t.Object({
        name: t.String(),
        /** GitHub's numeric installation id, as a string. */
        installationId: t.Optional(t.String()),
        /** "owner/name", or a local path when no installation is chosen. */
        repo: t.String(),
        branch: t.String(),
        pack: t.Optional(t.String()),
        dockerfilePath: t.Optional(t.String()),
        buildContext: t.Optional(t.String()),
        containerPort: t.Optional(t.String()),
        healthPath: t.Optional(t.String()),
        memoryLimitMb: t.Optional(t.Numeric()),
        csrf: t.String(),
      }),
    },
  )

  .get("/r/:resourceId", ({ params, query, session }) => {
    const ctx = getResourceContext(params.resourceId)
    if (!ctx) return statusFor(session, 404)
    const { resource, environment, project } = ctx

    const tab = ["overview", "logs", "env", "domains", "settings"].includes(
      String(query.tab),
    )
      ? String(query.tab)
      : "overview"

    const deployments = listDeployments(resource.id).map((d) => ({
      ...d,
      duration: formatDuration(d.startedAt, d.finishedAt),
      imagePending: d.image === BUILD_PLACEHOLDER,
    }))

    // SQLite only, never a GitHub call: this page renders on every tab switch
    // and must not stall behind a slow or unreachable API.
    const githubInstallations = listGithubInstallations().map((i) => ({
      installationId: i.installationId,
      accountLogin: i.accountLogin,
    }))

    return html(
      renderPage(
        "resource",
        {
          resource,
          environment,
          project,
          tab,
          image: resourceImage(resource),
          // Not deployments[0]: that may be a cancelled row, which did nothing
          // and must not define the state (D59).
          state: resourceState(resource, latestDeploymentStatus(resource.id)),
          deployments,
          domains: listDomains(resource.id),
          // Where a "Generate automatic domain" press would put one, when the
          // resource has none (D66). Never a hostname: that is only in rows.
          autoBase: autoDomainBase(),
          // Keys, origins and scopes — never values. resolveEnvKeys does not
          // decrypt, so the Resolved table carries no plaintext; the edit
          // boxes below are the one place values render.
          resolvedEnv: resolveEnvKeys(resource.id),
          // This level's own saved variables, decrypted for the edit boxes
          // (D45). Only on the env tab, so every other tab's HTML
          // stays value-free and cacheable.
          envText: tab === "env" ? getEnvText(resource.id) : undefined,
          logs: tail(resource.id, 300),
          githubInstallations,
          gitLink: gitLinkFor(resource.gitInstallationId, githubInstallations),
          csrf: session?.csrfToken,
        },
        layout(session, resource.name, {
          activeProjectId: project.id,
          errorKey: errorKeyFromQuery(query.error),
        }),
      ),
      tab === "env" ? NO_STORE : undefined,
    )
  })

  .post(
    "/r/:resourceId/deploy",
    ({ params, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)

      // A git resource's deploy always builds, so its row carries the
      // placeholder until the job resolves the new tag — never the image that
      // is running now, which a failed build would leave on its row (P-2).
      const image =
        ctx.resource.kind === "git"
          ? BUILD_PLACEHOLDER
          : resourceImage(ctx.resource)
      if (!image) return statusFor(session, 400)

      // An identical build deploy still waiting in the queue already does
      // what this press asks for, and concurrency 1 would run the copy right
      // after it for nothing — so the press goes to the waiting one.
      const existing = pendingDeploymentFor(ctx.resource.id, image)
      if (existing !== null) {
        logger.info(
          { resourceId: ctx.resource.id, deploymentId: existing },
          "deploy folded into a queued deploy",
        )
        return redirect(`/d/${existing}`, 303)
      }

      // Enqueue and redirect immediately — never await Docker in a handler.
      const deploymentId = enqueueDeploy(ctx.resource.id, image, "manual")
      return redirect(`/d/${deploymentId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/rollback",
    ({ params, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)
      const previous = ctx.resource.previousImage
      if (!previous) return statusFor(session, 400)

      const deploymentId = enqueueDeploy(ctx.resource.id, previous, "rollback")
      return redirect(`/d/${deploymentId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/stop",
    ({ params, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)
      enqueue("stop", { resourceId: ctx.resource.id })
      return redirect(`/r/${ctx.resource.id}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/env",
    ({ params, body, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)

      const parsed = parseScopedEnv(body)
      if (parsed.error) {
        return redirect(
          withError(`/r/${ctx.resource.id}?tab=env`, parsed.error),
          303,
        )
      }
      setEnvVars(ctx.resource.id, parsed.vars)
      return redirect(`/r/${ctx.resource.id}?tab=env`, 303)
    },
    { body: envBody },
  )

  .post(
    "/p/:projectId/env",
    ({ params, body, redirect, session }) => {
      if (!getProject(params.projectId)) return statusFor(session, 404)

      const parsed = parseScopedEnv(body)
      if (parsed.error) {
        return redirect(
          withError(`/p/${params.projectId}?tab=env`, parsed.error),
          303,
        )
      }
      setSharedEnvVars({ projectId: params.projectId }, parsed.vars)
      return redirect(`/p/${params.projectId}?tab=env`, 303)
    },
    { body: envBody },
  )

  // Addressed by environment id rather than nested under the project: an
  // environment id is globally unique, /e/ is already the environment
  // namespace in this router, and nesting would add a consistency check with
  // nothing to gain.
  .post(
    "/e/:environmentId/env",
    ({ params, body, redirect, session }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return statusFor(session, 404)

      const parsed = parseScopedEnv(body)
      // Back to the project page, which is where these are edited — /e/:id has
      // no page of its own. On success the fragment matches the
      // per-environment card so the user lands where they were; an error
      // carries none, because the notice is at the top of the page.
      const back = `/p/${environment.projectId}?tab=env`
      if (parsed.error) return redirect(withError(back, parsed.error), 303)
      setSharedEnvVars({ environmentId: environment.id }, parsed.vars)
      return redirect(`${back}#env-${environment.id}`, 303)
    },
    { body: envBody },
  )

  .post(
    "/r/:resourceId/domains",
    ({ params, body, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)

      const back = `/r/${ctx.resource.id}?tab=domains`
      const host = body.host.trim().toLowerCase()
      if (!isValidHostname(host)) {
        return redirect(withError(back, "domain-invalid"), 303)
      }
      if (domainExists(host)) {
        return redirect(withError(back, "domain-taken"), 303)
      }
      // The reverse of the dashboard form's check. Resource routes sit ahead of
      // the dashboard's, so this would hand the dashboard's name — and every
      // login typed through it — to the app (N-3). routeHosts filters it too.
      if (host === getDashboardHost()) {
        return redirect(withError(back, "domain-dashboard"), 303)
      }

      addDomain(ctx.resource.id, host, false)
      // Applied now rather than at the next deploy: the route is the proxy's
      // business, so the queue does it and this handler only redirects.
      enqueue("sync_routes", {})
      return redirect(`/r/${ctx.resource.id}?tab=domains`, 303)
    },
    { body: t.Object({ host: t.String(), csrf: t.String() }) },
  )

  /**
   * Gives a resource an automatic hostname it does not have: one created
   * before a base domain existed, or whose automatic row was removed (D66).
   * The button shows only when a base exists and the resource has none, so
   * either refusal here is a stale tab or a hand-made request.
   */
  .post(
    "/r/:resourceId/domains/auto",
    ({ params, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)
      if (!autoDomainBase()) return statusFor(session, 400)
      if (assignAutoDomain(ctx.resource.id)) enqueue("sync_routes", {})
      return redirect(`/r/${ctx.resource.id}?tab=domains`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/domains/:domainId/delete",
    ({ params, redirect }) => {
      deleteDomain(params.domainId)
      enqueue("sync_routes", {})
      return redirect(`/r/${params.resourceId}?tab=domains`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/settings",
    ({ params, body, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)

      // Parsed before any write, so a refused request stores nothing — not
      // even the image. Blank clears the port.
      const containerPort = parseContainerPort(body.containerPort)
      if (!containerPort.ok) return statusFor(session, 400)

      // The image field belongs to an image resource. A git resource builds its
      // own, so accepting one here would overwrite the repository spec and stop
      // it rebuilding — setResourceImage refuses, and this turns that refusal
      // into a useful message rather than a 500.
      if (ctx.resource.kind === "image") {
        if (!isValidImageRef(body.image)) {
          return redirect(
            withError(`/r/${ctx.resource.id}?tab=settings`, "image-invalid"),
            303,
          )
        }
        setResourceImage(ctx.resource.id, body.image)
      }
      updateResource(ctx.resource.id, {
        containerPort: containerPort.port,
        healthPath: body.healthPath?.trim() || null,
        memoryLimitMb: body.memoryLimitMb ?? config.defaultMemoryMb,
      })
      // A cleared port means no route, applied now by the queue. A CHANGED
      // port is not applied here: the sync keeps the port a live route already
      // dials, and the next deploy moves it after its health gate.
      enqueue("sync_routes", {})
      return redirect(`/r/${ctx.resource.id}?tab=settings`, 303)
    },
    {
      body: t.Object({
        image: t.String(),
        containerPort: t.Optional(t.String()),
        healthPath: t.Optional(t.String()),
        memoryLimitMb: t.Optional(t.Numeric()),
        csrf: t.String(),
      }),
    },
  )

  /**
   * Auto-deploy on push, for a git resource.
   *
   * An unchecked HTML checkbox submits NOTHING, so an absent `enabled` is the
   * off signal rather than a missing field. Reading it as "unchanged" would
   * make the box impossible to untick.
   */
  .post(
    "/r/:resourceId/auto-deploy",
    ({ params, body, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)
      if (ctx.resource.kind !== "git") return statusFor(session, 400)
      setAutoDeploy(ctx.resource.id, body.enabled === "on")
      return redirect(`/r/${ctx.resource.id}?tab=settings`, 303)
    },
    {
      body: t.Object({
        enabled: t.Optional(t.String()),
        csrf: t.String(),
      }),
    },
  )

  /**
   * Re-points a git resource at a different installation, repository or
   * branch — after an uninstall, a reinstall or a repository transfer, without
   * deleting and recreating it.
   *
   * Validated by the same checkGitSource as the create route, so re-linking
   * accepts nothing creating refuses. Unlike create, a bad repository here is
   * a keyed notice rather than a 400: this form's repo field is typed by hand,
   * not filled by the picker.
   *
   * Saves and nothing more — no deploy is enqueued. The next manual deploy or
   * matching push builds from the new source.
   */
  .post(
    "/r/:resourceId/source",
    ({ params, body, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)
      if (ctx.resource.kind !== "git") return statusFor(session, 400)

      const back = `/r/${ctx.resource.id}?tab=settings`
      const source = checkGitSource(body)
      if (!source.ok) {
        switch (source.refusal) {
          case "no-repo":
            return redirect(withError(back, "source-repo-required"), 303)
          case "bad-repo":
            return redirect(withError(back, "repo-invalid"), 303)
          case "bad-branch":
            return redirect(withError(back, "branch-invalid"), 303)
          // The select only offers known installations, so only a stale tab
          // or a hand-made request reaches this.
          case "bad-installation":
            return statusFor(session, 400)
        }
      }

      setGitSource(ctx.resource.id, {
        installationId: source.installationId,
        repo: source.repo,
        branch: source.branch,
      })
      logger.info(
        {
          resourceId: ctx.resource.id,
          installationId: source.installationId,
        },
        "git resource source changed",
      )
      return redirect(back, 303)
    },
    {
      body: t.Object({
        /** GitHub's numeric installation id, as a string; empty for none. */
        installationId: t.Optional(t.String()),
        repo: t.String(),
        branch: t.String(),
        csrf: t.String(),
      }),
    },
  )

  /**
   * Renames a resource. Only the display name changes: the slug, and with it
   * the image tag and every hostname, stays as it was (D65).
   */
  .post(
    "/r/:resourceId/rename",
    ({ params, body, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)
      const name = normalizeDisplayName(body.name)
      if (!isValidDisplayName(name)) return statusFor(session, 400)
      const back = `/r/${ctx.resource.id}?tab=settings`
      const other = findResourceByNameInEnv(ctx.environment.id, name)
      if (other && other.id !== ctx.resource.id) {
        return redirect(withError(back, "resource-name-taken"), 303)
      }
      updateResource(ctx.resource.id, { name })
      return redirect(back, 303)
    },
    { body: t.Object({ name: t.String({ maxLength: 60 }), csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/delete",
    ({ params, redirect, session }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return statusFor(session, 404)
      const projectId = ctx.project.id
      // Cleanup ordering lives in the job: container, route, volumes, then row.
      enqueue("remove", { resourceId: ctx.resource.id, deleteRow: true })
      return redirect(`/p/${projectId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .get("/d/:deploymentId", ({ params, query, session }) => {
    const deployment = getDeployment(params.deploymentId)
    // The page has no context of its own: the breadcrumb and the sidebar's
    // Projects highlight both come from the resource it belongs to.
    const ctx = deployment && getResourceContext(deployment.resourceId)
    if (!deployment || !ctx) return statusFor(session, 404)
    // What "Deploy this again" would repeat, for the button's confirm text;
    // null hides the button. Pure: no Docker or GitHub call on a page render.
    const sha = deployment.commitSha
    const redeploy = redeployable(deployment, ctx.resource)
      ? {
          kind: ctx.resource.kind,
          sha7: sha !== null && isFullCommitSha(sha) ? sha.slice(0, 7) : null,
          image:
            deployment.image === BUILD_PLACEHOLDER ? null : deployment.image,
        }
      : null
    return html(
      renderPage(
        "deployment",
        {
          deployment,
          resource: ctx.resource,
          environment: ctx.environment,
          project: ctx.project,
          duration: formatDuration(deployment.startedAt, deployment.finishedAt),
          imagePending: deployment.image === BUILD_PLACEHOLDER,
          lines: deployLogTail(params.deploymentId),
          csrf: session?.csrfToken,
          redeploy,
        },
        layout(session, "Deployment", {
          activeProjectId: ctx.project.id,
          errorKey: errorKeyFromQuery(query.error),
        }),
      ),
    )
  })

  /**
   * Removes a queued deploy from the queue (D59).
   *
   * No await anywhere, and no Docker: the cancel is one guarded UPDATE racing
   * the worker's claim, and whichever runs first wins outright. Losing that
   * race is not an error the user caused, so it redirects back with a notice
   * rather than a status page.
   */
  .post(
    "/d/:deploymentId/cancel",
    ({ params, redirect, session }) => {
      const deployment = getDeployment(params.deploymentId)
      if (!deployment) return statusFor(session, 404)
      // The reconciler's redeploys heal drift; cancelling one would leave the
      // resource down until the next pass re-queued it. The form never shows
      // for them, so reaching here means a hand-made request.
      if (deployment.trigger === "reconcile") return statusFor(session, 400)

      const back = `/d/${deployment.id}`
      // Already done — a double submit, or a second tab. The outcome the user
      // asked for holds, so there is nothing to report.
      if (deployment.status === "cancelled") return redirect(back, 303)

      if (cancelQueuedDeploy(deployment.id, deployment.resourceId)) {
        return redirect(back, 303)
      }
      return redirect(withError(back, "deploy-already-started"), 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  /**
   * "Deploy this again" (D61): a new deployment repeating a finished one.
   *
   * No await, no Docker, no GitHub: whether the image is still on the server,
   * and whether the commit can be built again, is decided by the job, which
   * says why in the deploy log when it cannot. A deployment the page would not
   * offer the button for is a hand-made request, so it gets a 400.
   */
  .post(
    "/d/:deploymentId/redeploy",
    ({ params, redirect, session }) => {
      const deployment = getDeployment(params.deploymentId)
      const ctx = deployment && getResourceContext(deployment.resourceId)
      if (!deployment || !ctx) return statusFor(session, 404)
      if (!redeployable(deployment, ctx.resource)) {
        return statusFor(session, 400)
      }

      const deploymentId = enqueueRedeploy(deployment, ctx.resource)
      logger.info(
        {
          resourceId: ctx.resource.id,
          sourceDeploymentId: deployment.id,
          deploymentId,
        },
        "redeploy queued",
      )
      return redirect(`/d/${deploymentId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  // --------------------------------------------------------------- github

  /**
   * The Settings page.
   *
   * The view model is assembled by settingsViewModel() rather than here, so
   * this handler cannot accidentally hand the template a spread of the App row
   * — which carries three ciphertext columns.
   */
  .get("/settings", ({ query, session }) => {
    const view = settingsViewModel({
      csrf: session?.csrfToken ?? "",
      flash: flashFromQuery(query.flash, query.msg),
    })
    const restarting = query.restarting === "1"
    // Spread into a literal rather than casting: an interface has no index
    // signature, so SettingsView is not assignable to Record<string, unknown>
    // directly, and a cast would also silence a genuine shape mismatch.
    return html(
      renderPage(
        "settings",
        // The dashboard data is a SIBLING key, never a widening of SettingsView:
        // that shape carries the rule about never spreading the github_apps row,
        // and nothing on this path should be able to reach it.
        {
          ...view,
          host: dashboardHostView(),
          restarting,
          // Set only by the hostname save's own redirect, whose flash already
          // says "applying" — so the page does not say it twice (M-3), while an
          // unrelated flash no longer hides the note (N-11).
          hostJustSaved: query.saved === "host",
          publicIp: {
            value: getPublicIp(),
            fromEnv:
              getSetting(SETTING_PUBLIC_IP) === undefined &&
              config.publicIp !== undefined,
            wildcard: config.wildcardDomain,
            justSaved: query.saved === "ip",
          },
        },
        // The layout renders the flash, above the page head. Settings is the
        // first route to hand it one; the page no longer renders its own.
        {
          ...layout(session, "Settings", {
            section: "settings",
            errorKey: errorKeyFromQuery(query.error),
          }),
          flash: view.flash,
        },
      ),
    )
  })

  /**
   * Sets, or clears, the hostname the dashboard answers on.
   *
   * Writes the row and enqueues; the route change itself happens on the worker.
   * An empty value writes an empty row rather than deleting it, because an
   * absent row falls through to MUSDASH_DASHBOARD_HOST — and an operator who
   * clears the field means "none", including the environment's.
   */
  .post(
    "/settings/dashboard-host",
    ({ body, redirect }) => {
      const host = normalizeHost(body.host)

      if (host !== "" && !isValidHostname(host)) {
        return redirect(
          flashUrl(
            "error",
            "That does not look like a hostname. Use a name you have pointed at this server, for example mus.example.com.",
          ),
          303,
        )
      }
      // A resource route for the same name is earlier in the array and terminal,
      // so it would win silently and the dashboard would be unreachable at the
      // name just set.
      if (host !== "" && domainExists(host)) {
        return redirect(
          flashUrl(
            "error",
            `${host} is already attached to a resource. Remove it there first, or choose another name.`,
          ),
          303,
        )
      }

      setDashboardHost(host)
      enqueue("apply_dashboard_host", {})
      return redirect(
        `${flashUrl(
          "ok",
          host === ""
            ? "Cleared. The dashboard answers on this server's address again."
            : `Saved. Applying ${host} to the proxy — a certificate follows within a few seconds.`,
        )}&saved=host`,
        303,
      )
    },
    {
      body: t.Object({ host: t.String({ maxLength: 300 }), csrf: t.String() }),
    },
  )

  /**
   * Sets, or clears, the public IPv4 address automatic sslip.io hostnames use
   * (D66). Only new automatic hostnames follow it: existing ones are rows, and
   * moving them would move live URLs. An empty value writes an empty row, so
   * MUSDASH_PUBLIC_IP stops applying too.
   */
  .post(
    "/settings/public-ip",
    ({ body, redirect }) => {
      const ip = body.ip.trim()
      if (ip !== "" && !isPublicIPv4(ip)) {
        return redirect(withError("/settings", "public-ip-invalid"), 303)
      }
      setPublicIp(ip)
      return redirect("/settings?saved=ip", 303)
    },
    { body: t.Object({ ip: t.String({ maxLength: 64 }), csrf: t.String() }) },
  )

  /**
   * Restarts musdash.
   *
   * Deliberately not a job: the worker completes a job only after its handler
   * returns, so a handler that exits the process leaves its row leased and
   * lease recovery at the next start runs it — and restarts the process — again.
   * Nothing is awaited here either — the exit is deferred past this response.
   */
  .post(
    "/settings/restart",
    ({ redirect }) => {
      if (restartCapability() !== "systemd") {
        return redirect(
          flashUrl(
            "error",
            "Nothing is supervising this process, so it would stop rather than restart. Restart it the way you started it.",
          ),
          303,
        )
      }
      const blocked = restartBlockedReason()
      if (blocked) return redirect(flashUrl("error", blocked), 303)

      requestRestart()
      return redirect(
        `${flashUrl("ok", "Restarting — this page reloads in a few seconds.")}&restarting=1`,
        303,
      )
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  /**
   * Step one of GitHub's App-manifest flow.
   *
   * Answers with HTML rather than a redirect because the flow requires a POST:
   * GitHub wants a form submitted to /settings/apps/new?state=<nonce> carrying
   * a single `manifest` field holding the JSON descriptor. A redirect cannot
   * express that, so the page below submits itself and the user never reads it.
   * That is why the markup is inline machinery rather than an Eta page.
   */
  .post(
    "/settings/github/connect",
    ({ redirect }) => {
      // The nonce lives in `settings`, not a module-level Map: one long-running
      // process is an invariant, but a restart mid-flow must not strand the
      // user at a callback that can no longer be validated.
      const state = randomToken()
      setSetting(SETTING_GITHUB_MANIFEST_STATE, state)

      // GitHub App names are globally unique, so a bare "musdash" collides for
      // the second person who ever tries this. The route generates the
      // disambiguated name; buildManifest stays pure.
      const name = `musdash-${randomToken(3).slice(0, 6)}`

      let manifest: string
      try {
        manifest = JSON.stringify(buildManifest(getPublicUrl(), name))
      } catch (err) {
        // The only expected failure is having no dashboard domain yet. Anything
        // else is a bug, and goes to handleError as one rather than being
        // reported to the user as a missing domain.
        if (!(err instanceof ManifestError)) throw err
        logger.warn(
          { err: err.message },
          "GitHub App manifest could not be built",
        )
        return redirect(withError("/settings", "github-no-domain"), 303)
      }

      const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`
      return html(
        `<!doctype html><html><body onload="document.forms[0].submit()">` +
          `<form method="post" action="${escapeHtml(action)}">` +
          `<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">` +
          `<noscript><button type="submit">Continue to GitHub</button></noscript>` +
          `</form></body></html>`,
      )
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  /**
   * Step two: GitHub redirects back with a single-use code.
   *
   * This is a GET, so it carries no CSRF token — the `state` nonce is what
   * proves the callback belongs to a flow this instance started.
   */
  .get("/settings/github/callback", async ({ query, redirect }) => {
    const expected = getSetting(SETTING_GITHUB_MANIFEST_STATE)
    if (!expected) {
      return redirect(withError("/settings", "github-no-flow"), 303)
    }
    if (!safeEqual(expected, String(query.state ?? ""))) {
      logger.warn({}, "GitHub callback state did not match")
      return redirect(withError("/settings", "github-state-mismatch"), 303)
    }
    // Consumed BEFORE anything else can fail, so a replayed callback cannot
    // re-enter the exchange with the same nonce.
    deleteSetting(SETTING_GITHUB_MANIFEST_STATE)

    const code = String(query.code ?? "")
    if (!code) return redirect(withError("/settings", "github-no-code"), 303)

    try {
      // NEVER log the result or any field of it. client_secret and
      // webhook_secret are not matched by redactGithub's patterns, so the
      // backstop would not save a careless line here.
      const converted = await convertManifestCode(code)
      replaceGithubApp(converted)
      // Mandatory after ANY App change: tokens and repository lists are cached
      // by installation id, and a stale cache would shadow the new App's.
      clearGitHubCaches()
      logger.info({ appId: converted.appId }, "registered a GitHub App")
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        "GitHub App registration failed",
      )
      return redirect(flashUrl("error", "GitHub registration failed."), 303)
    }

    // A sync failure is not fatal — the App is registered either way, and the
    // Sync button exists precisely for this.
    const synced = await syncInstallations().catch((err: unknown) => {
      logger.warn(
        { err: (err as Error).message },
        "could not sync installations after registration",
      )
      return null
    })

    return redirect(
      synced === null
        ? flashUrl(
            "error",
            "GitHub is connected, but syncing installations failed.",
          )
        : flashUrl("ok", "GitHub is connected."),
      303,
    )
  })

  .post(
    "/settings/github/sync",
    async ({ redirect }) => {
      const count = await syncInstallations().catch((err: unknown) => {
        logger.warn({ err: (err as Error).message }, "installation sync failed")
        return null
      })
      return redirect(
        count === null
          ? flashUrl("error", "Could not reach GitHub.")
          : flashUrl("ok", `Synced ${count} installation(s).`),
        303,
      )
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  /**
   * Disconnects GitHub entirely.
   *
   * Deleting the App cascades to its installations, which leaves every git
   * resource holding an installation id that no longer resolves — there is no
   * foreign key to clean it up (0002_github.sql:37). clearGitLinkage NULLs
   * those first, so the failure is "no installation selected" in the UI rather
   * than a 404 from GitHub at the next deploy.
   */
  .post(
    "/settings/github/disconnect",
    ({ body, redirect }) => {
      if (body.confirm !== "disconnect") {
        return redirect(withError("/settings", "github-confirm"), 303)
      }
      const app = getGithubApp()
      if (!app)
        return redirect(flashUrl("ok", "GitHub was not connected."), 303)

      let unlinked = 0
      for (const installation of listGithubInstallations()) {
        unlinked += clearGitLinkage(String(installation.installationId))
      }
      deleteGithubApp(app.id)
      // Same reason as registration: a revoked App's tokens and repository
      // lists must not linger in memory.
      clearGitHubCaches()

      logger.info({ appId: app.appId, unlinked }, "disconnected GitHub")
      return redirect(flashUrl("ok", "GitHub is disconnected."), 303)
    },
    { body: t.Object({ confirm: t.String(), csrf: t.String() }) },
  )

// --------------------------------------------------------------- helpers

/** What the resource page says about a git resource's GitHub linkage. */
type GitLink =
  | { kind: "none" }
  | { kind: "linked"; accountLogin: string }
  | { kind: "stale" }

/**
 * Resolves a resource's stored installation id against the known ones.
 *
 * "stale" is an id that matches no installation — left by a missed uninstall
 * webhook before a sync, or written before unlinking existed. It is shown
 * rather than hidden because its next deploy would 404 at GitHub, and the
 * re-link form is how the user fixes it. The column holds GitHub's integer as
 * a decimal string, so the comparison is on the string form.
 */
function gitLinkFor(
  gitInstallationId: string | null,
  installations: { installationId: number; accountLogin: string }[],
): GitLink {
  if (gitInstallationId === null) return { kind: "none" }
  const match = installations.find(
    (i) => String(i.installationId) === gitInstallationId,
  )
  return match
    ? { kind: "linked", accountLogin: match.accountLogin }
    : { kind: "stale" }
}

interface GitPickerRepo {
  fullName: string
  defaultBranch: string
  private: boolean
}

interface GitPickerInstallation {
  installationId: number
  accountLogin: string
  repos: readonly GitPickerRepo[]
  /** Non-null when this installation's listing failed. */
  error: string | null
}

interface GitPicker {
  connected: boolean
  installations: GitPickerInstallation[]
}

/**
 * The repository choices for the project page's git dialog.
 *
 * Rendered server-side at page load, on a cache miss one API call per
 * installation, rather than from a client fetch endpoint — the UI is a view of
 * server state and this project does not add an XHR API to populate a
 * <select>.
 *
 * Each call is isolated: an installation the user revoked on GitHub still has
 * a row here, and its token mint 404s. Letting that reject would take down the
 * whole project page for a resource that has nothing to do with GitHub.
 *
 * Caveat, surfaced in the template: on a cache miss listInstallationRepos
 * paginates to completion at 100/page, so an installation granting several
 * hundred repositories makes that render slow, and every render's HTML large.
 * The fix is to scope the installation to fewer repositories, not to fetch
 * from the client.
 */
async function gitPicker(): Promise<GitPicker> {
  const installations = listGithubInstallations()
  if (installations.length === 0) {
    return { connected: false, installations: [] }
  }

  const resolved = await Promise.all(
    installations.map(async (installation) => {
      try {
        return {
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          repos: await cachedInstallationRepos(installation.installationId),
          error: null,
        }
      } catch (err) {
        // The detail goes to the log; the page gets a sentence. Returning the
        // raw message would put a GitHub API body in front of the user.
        logger.warn(
          {
            installationId: installation.installationId,
            err: (err as Error).message,
          },
          "could not list repositories for an installation",
        )
        return {
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          repos: [],
          error: "Could not read repositories for this installation.",
        }
      }
    }),
  )

  return { connected: true, installations: resolved }
}

function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
): string {
  if (!startedAt) return "—"
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const secs = Math.max(
    0,
    Math.round((end - new Date(startedAt).getTime()) / 1000),
  )
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}
