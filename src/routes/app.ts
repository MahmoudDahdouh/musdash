import { Elysia, t } from "elysia"
import {
  resolveSession,
  SESSION_COOKIE,
  verifyCsrf,
  type SessionUser,
} from "../auth.ts"
import { autoDomainFor } from "../caddy/client.ts"
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
  getEnvironment,
  getGithubApp,
  getProject,
  getResourceContext,
  getSetting,
  listDeployments,
  listDomains,
  listEnvironments,
  listGithubInstallations,
  listProjects,
  listResources,
  listSharedEnvKeys,
  navTree,
  resolveEnvKeys,
  resourceImage,
  setAutoDeploy,
  setEnvVars,
  setResourceImage,
  setSetting,
  setSharedEnvVars,
  updateResource,
  type EnvVarInput,
} from "../db/queries.ts"
import { parseEnvText } from "../env/parse.ts"
import { buildManifest } from "../github/manifest.ts"
import {
  convertManifestCode,
  replaceGithubApp,
  syncInstallations,
} from "../github/register.ts"
import {
  isValidGitRef,
  isValidRepoRef,
  listInstallationRepos,
} from "../github/repos.ts"
import { flashFromQuery, settingsViewModel } from "../github/settings.ts"
import { clearTokenCache } from "../github/tokens.ts"
import { enqueueDeploy } from "../jobs/deploy.ts"
import { logger } from "../log.ts"
import { tail } from "../logs/buffer.ts"
import { enqueue } from "../queue/index.ts"
import { renderPage } from "../views/render.ts"

const html = (body: string) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })

/** The manifest-flow nonce, held in `settings` so a restart cannot strand it. */
const GITHUB_MANIFEST_STATE = "github_manifest_state"

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
 * In the query string rather than a server-side flash store, matching the
 * envError convention the env tab already uses: no per-session state to hold,
 * and nothing to clean up if the user never follows the redirect.
 */
function flashUrl(kind: "ok" | "error", text: string): string {
  return `/settings?flash=${kind}&msg=${encodeURIComponent(text)}`
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
 */
function parseScopedEnv(body: {
  runtime?: string
  build?: string
  both?: string
}): { vars: EnvVarInput[]; errors: string[] } {
  const vars: EnvVarInput[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (const scope of ["runtime", "build", "both"] as const) {
    const parsed = parseEnvText(body[scope] ?? "")
    for (const e of parsed.errors) errors.push(`${scope}: ${e}`)
    for (const [key, value] of Object.entries(parsed.vars)) {
      if (seen.has(key)) {
        errors.push(`"${key}" appears in more than one scope box; pick one`)
        continue
      }
      seen.add(key)
      vars.push({ key, value, scope })
    }
  }
  return { vars, errors }
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
      return new Response("invalid CSRF token", { status: 403 })
    }
  })

  // ------------------------------------------------------------- projects

  .get("/", ({ session }) => {
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
        layout(session, "Projects"),
      ),
    )
  })

  .post(
    "/projects",
    ({ body, redirect }) => {
      const project = createProject(body.name.trim(), body.description?.trim())
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

  .get("/p/:projectId", async ({ params, query, session, status }) => {
    const project = getProject(params.projectId)
    if (!project) return status(404, "project not found")

    const tab = ["resources", "env"].includes(String(query.tab))
      ? String(query.tab)
      : "resources"

    const environments = listEnvironments(project.id).map((environment) => ({
      environment,
      sharedEnv: listSharedEnvKeys({ environmentId: environment.id }),
      resources: listResources(environment.id).map((resource) => ({
        resource,
        image: resourceImage(resource),
        state: uiState(resource.desiredState, resource.containerId),
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
          envError: query.envError ? String(query.envError) : null,
          projectEnv: listSharedEnvKeys({ projectId: project.id }),
          csrf: session?.csrfToken,
          defaultMemoryMb: config.defaultMemoryMb,
          // Only on the resources tab: gitPicker makes one GitHub API call per
          // installation, and the env tab renders none of it.
          gitPicker:
            tab === "resources"
              ? await gitPicker()
              : { connected: false, installations: [] },
        },
        layout(session, project.name, { activeProjectId: project.id }),
      ),
    )
  })

  .post(
    "/p/:projectId/environments",
    ({ params, body, redirect, status }) => {
      if (!getProject(params.projectId)) return status(404, "project not found")
      if (!isValidResourceName(body.name)) {
        return status(400, "environment names must match [a-z0-9-]{1,32}")
      }
      createEnvironment(params.projectId, body.name)
      return redirect(`/p/${params.projectId}`, 303)
    },
    { body: t.Object({ name: t.String(), csrf: t.String() }) },
  )

  // ------------------------------------------------------------ resources

  .post(
    "/e/:environmentId/resources",
    ({ params, body, redirect, status }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return status(404, "environment not found")

      // Names become container names and DNS labels; images can reach a shell.
      if (!isValidResourceName(body.name)) {
        return status(400, "resource names must match [a-z0-9-]{1,32}")
      }
      if (!isValidImageRef(body.image)) {
        return status(400, "that does not look like a valid image reference")
      }
      if (findResourceByNameInEnv(environment.id, body.name)) {
        return status(409, "a resource with that name already exists here")
      }

      const resource = createResource({
        environmentId: environment.id,
        name: body.name,
        image: body.image,
        containerPort: body.containerPort ?? null,
        healthPath: body.healthPath?.trim() || null,
        memoryLimitMb: body.memoryLimitMb ?? config.defaultMemoryMb,
      })

      // Give it its automatic subdomain up front, so deploying is one click.
      const auto = autoDomainFor(resource.name, environment.name)
      if (auto && !domainExists(auto)) addDomain(resource.id, auto, true)

      return redirect(`/r/${resource.id}`, 303)
    },
    {
      body: t.Object({
        name: t.String(),
        image: t.String(),
        containerPort: t.Optional(t.Numeric()),
        healthPath: t.Optional(t.String()),
        memoryLimitMb: t.Optional(t.Numeric()),
        csrf: t.String(),
      }),
    },
  )

  /**
   * A resource built from a repository.
   *
   * Two shapes, and the difference is deliberate. WITH an installation the repo
   * came from the picker and is validated as a real repository reference and a
   * real git ref, because both become path segments in a GitHub URL. WITHOUT
   * one, the repo stays free text: githubSourceFetcher falls back to a local
   * directory when the value is not a repository reference
   * (tarball.ts:128-134), and that seam is how checkpoint 3's build
   * verification runs on a box with no GitHub at all. Requiring isValidRepoRef
   * unconditionally would remove it.
   */
  .post(
    "/e/:environmentId/resources/git",
    ({ params, body, redirect, status }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return status(404, "environment not found")

      if (!isValidResourceName(body.name)) {
        return status(400, "resource names must match [a-z0-9-]{1,32}")
      }
      if (findResourceByNameInEnv(environment.id, body.name)) {
        return status(409, "a resource with that name already exists here")
      }
      const repo = body.repo.trim()
      const branch = body.branch.trim() || "main"
      if (!repo) return status(400, "a repository is required")

      const installationId = body.installationId?.trim() || null
      if (installationId !== null) {
        // Stored as GitHub's integer in DECIMAL STRING form, because
        // tarball.ts:139 does Number() on it and throws if the result is not
        // finite. Anything else here fails at deploy time, not now.
        if (!/^\d+$/.test(installationId)) {
          return status(400, "that is not a valid installation")
        }
        // Checked against installationId (GitHub's number), never against the
        // ULID row id — they are different values and the row id would never
        // match.
        const known = listGithubInstallations().some(
          (i) => String(i.installationId) === installationId,
        )
        if (!known) return status(400, "that installation is not connected")

        if (!isValidRepoRef(repo)) {
          return status(400, "a repository must look like owner/name")
        }
        if (!isValidGitRef(branch)) {
          return status(400, "that is not a valid branch name")
        }
      }

      const resource = createGitResource({
        environmentId: environment.id,
        name: body.name,
        repo,
        branch,
        // Empty means "detect at build time" — the value is only read when the
        // user has made an explicit choice.
        pack: body.pack === "dockerfile" ? "dockerfile" : "railpack",
        dockerfilePath: body.dockerfilePath?.trim() || null,
        buildContext: body.buildContext?.trim() || null,
        installationId,
        containerPort: body.containerPort ?? null,
        healthPath: body.healthPath?.trim() || null,
        memoryLimitMb: body.memoryLimitMb ?? config.defaultMemoryMb,
      })

      const auto = autoDomainFor(resource.name, environment.name)
      if (auto && !domainExists(auto)) addDomain(resource.id, auto, true)

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
        containerPort: t.Optional(t.Numeric()),
        healthPath: t.Optional(t.String()),
        memoryLimitMb: t.Optional(t.Numeric()),
        csrf: t.String(),
      }),
    },
  )

  .get("/r/:resourceId", ({ params, query, session, status }) => {
    const ctx = getResourceContext(params.resourceId)
    if (!ctx) return status(404, "resource not found")
    const { resource, environment, project } = ctx

    const tab = ["overview", "logs", "env", "domains", "settings"].includes(
      String(query.tab),
    )
      ? String(query.tab)
      : "overview"

    const deployments = listDeployments(resource.id).map((d) => ({
      ...d,
      duration: formatDuration(d.startedAt, d.finishedAt),
      pill: d.status,
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
          state: uiState(resource.desiredState, resource.containerId),
          deployments,
          domains: listDomains(resource.id),
          autoDomain: autoDomainFor(resource.name, environment.name),
          // Keys, origins and scopes — never values. resolveEnvKeys does not
          // decrypt, so no plaintext can reach the template.
          resolvedEnv: resolveEnvKeys(resource.id),
          envError: query.envError ? String(query.envError) : null,
          logs: tail(resource.id, 300),
          csrf: session?.csrfToken,
        },
        layout(session, resource.name, {
          activeProjectId: project.id,
          activeEnvironmentId: environment.id,
        }),
      ),
    )
  })

  .post(
    "/r/:resourceId/deploy",
    ({ params, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")

      // A git resource has no image until it has built one, and requiring it
      // here would make the very first deploy impossible. The job resolves the
      // real tag when it builds; this placeholder only labels the row until
      // then.
      const image = resourceImage(ctx.resource)
      if (!image && ctx.resource.kind !== "git") {
        return status(400, "this resource has no image set")
      }

      // Enqueue and redirect immediately — never await Docker in a handler.
      const deploymentId = enqueueDeploy(
        ctx.resource.id,
        image || "(building)",
        "manual",
      )
      return redirect(`/d/${deploymentId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/rollback",
    ({ params, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")
      const previous = ctx.resource.previousImage
      if (!previous)
        return status(400, "there is no previous image to roll back to")

      const deploymentId = enqueueDeploy(ctx.resource.id, previous, "rollback")
      return redirect(`/d/${deploymentId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/stop",
    ({ params, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")
      enqueue("stop", { resourceId: ctx.resource.id })
      return redirect(`/r/${ctx.resource.id}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/env",
    ({ params, body, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")

      const parsed = parseScopedEnv(body)
      if (parsed.errors.length > 0) {
        const msg = encodeURIComponent(parsed.errors.join("; "))
        return redirect(`/r/${ctx.resource.id}?tab=env&envError=${msg}`, 303)
      }
      setEnvVars(ctx.resource.id, parsed.vars)
      return redirect(`/r/${ctx.resource.id}?tab=env`, 303)
    },
    { body: envBody },
  )

  .post(
    "/p/:projectId/env",
    ({ params, body, redirect, status }) => {
      if (!getProject(params.projectId)) return status(404, "project not found")

      const parsed = parseScopedEnv(body)
      if (parsed.errors.length > 0) {
        const msg = encodeURIComponent(parsed.errors.join("; "))
        return redirect(`/p/${params.projectId}?tab=env&envError=${msg}`, 303)
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
    ({ params, body, redirect, status }) => {
      const environment = getEnvironment(params.environmentId)
      if (!environment) return status(404, "environment not found")

      const parsed = parseScopedEnv(body)
      // Back to the project page, which is where these are edited — /e/:id has
      // no page of its own. The fragment matches the per-environment card so
      // the user lands where they were.
      const back = `/p/${environment.projectId}?tab=env`
      if (parsed.errors.length > 0) {
        const msg = encodeURIComponent(parsed.errors.join("; "))
        return redirect(`${back}&envError=${msg}#env-${environment.id}`, 303)
      }
      setSharedEnvVars({ environmentId: environment.id }, parsed.vars)
      return redirect(`${back}#env-${environment.id}`, 303)
    },
    { body: envBody },
  )

  .post(
    "/r/:resourceId/domains",
    ({ params, body, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")

      const host = body.host.trim().toLowerCase()
      // Must be a dotted hostname: label(.label)+, no leading/trailing dash.
      const hostShape =
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
      if (host.length > 253 || !hostShape.test(host)) {
        return status(400, "that does not look like a hostname")
      }
      if (domainExists(host))
        return status(409, "that domain is already in use")

      addDomain(ctx.resource.id, host, false)
      return redirect(`/r/${ctx.resource.id}?tab=domains`, 303)
    },
    { body: t.Object({ host: t.String(), csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/domains/:domainId/delete",
    ({ params, redirect }) => {
      deleteDomain(params.domainId)
      return redirect(`/r/${params.resourceId}?tab=domains`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .post(
    "/r/:resourceId/settings",
    ({ params, body, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")

      // The image field belongs to an image resource. A git resource builds its
      // own, so accepting one here would overwrite the repository spec and stop
      // it rebuilding — setResourceImage refuses, and this turns that refusal
      // into a useful message rather than a 500.
      if (ctx.resource.kind === "image") {
        if (!isValidImageRef(body.image)) {
          return status(400, "that does not look like a valid image reference")
        }
        setResourceImage(ctx.resource.id, body.image)
      }
      updateResource(ctx.resource.id, {
        containerPort: body.containerPort ?? null,
        healthPath: body.healthPath?.trim() || null,
        memoryLimitMb: body.memoryLimitMb ?? config.defaultMemoryMb,
      })
      return redirect(`/r/${ctx.resource.id}?tab=settings`, 303)
    },
    {
      body: t.Object({
        image: t.String(),
        containerPort: t.Optional(t.Numeric()),
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
    ({ params, body, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")
      if (ctx.resource.kind !== "git") {
        return status(400, "only a repository resource deploys on push")
      }
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

  .post(
    "/r/:resourceId/delete",
    ({ params, redirect, status }) => {
      const ctx = getResourceContext(params.resourceId)
      if (!ctx) return status(404, "resource not found")
      const projectId = ctx.project.id
      // Cleanup ordering lives in the job: container, route, volumes, then row.
      enqueue("remove", { resourceId: ctx.resource.id, deleteRow: true })
      return redirect(`/p/${projectId}`, 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

  .get("/d/:deploymentId", ({ params, session, status }) => {
    const deployment = deploymentWithResource(params.deploymentId)
    if (!deployment) return status(404, "deployment not found")
    // This page has no project context of its own; resolve it from the
    // resource so the sidebar highlights the branch the user came from.
    const ctx = getResourceContext(deployment.resource.id)
    return html(
      renderPage(
        "deployment",
        {
          deployment: deployment.deployment,
          resource: deployment.resource,
          pill: deployment.deployment.status,
          lines: deployLines(params.deploymentId),
        },
        layout(session, "Deployment", {
          activeProjectId: ctx?.project.id,
          activeEnvironmentId: ctx?.environment.id,
        }),
      ),
    )
  })

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
    // Spread into a literal rather than casting: an interface has no index
    // signature, so SettingsView is not assignable to Record<string, unknown>
    // directly, and a cast would also silence a genuine shape mismatch.
    return html(
      renderPage(
        "settings",
        { ...view },
        layout(session, "Settings", { activeSettings: true }),
      ),
    )
  })

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
    ({ status }) => {
      // The nonce lives in `settings`, not a module-level Map: one long-running
      // process is an invariant, but a restart mid-flow must not strand the
      // user at a callback that can no longer be validated.
      const state = randomToken()
      setSetting(GITHUB_MANIFEST_STATE, state)

      // GitHub App names are globally unique, so a bare "musdash" collides for
      // the second person who ever tries this. The route generates the
      // disambiguated name; buildManifest stays pure.
      const name = `musdash-${randomToken(3).slice(0, 6)}`

      let manifest: string
      try {
        manifest = JSON.stringify(buildManifest(config.publicUrl, name))
      } catch (err) {
        // The only expected failure is an unset MUSDASH_PUBLIC_URL, whose
        // message is written to be read by a user.
        logger.warn(
          { err: (err as Error).message },
          "GitHub App manifest could not be built",
        )
        return status(400, (err as Error).message)
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
  .get("/settings/github/callback", async ({ query, redirect, status }) => {
    const expected = getSetting(GITHUB_MANIFEST_STATE)
    if (!expected) {
      return status(400, "there is no GitHub connection in progress")
    }
    if (!safeEqual(expected, String(query.state ?? ""))) {
      logger.warn({}, "GitHub callback state did not match")
      return status(400, "that GitHub callback did not match this session")
    }
    // Consumed BEFORE anything else can fail, so a replayed callback cannot
    // re-enter the exchange with the same nonce.
    deleteSetting(GITHUB_MANIFEST_STATE)

    const code = String(query.code ?? "")
    if (!code) return status(400, "GitHub did not return a registration code")

    try {
      // NEVER log the result or any field of it. client_secret and
      // webhook_secret are not matched by redactGithub's patterns, so the
      // backstop would not save a careless line here.
      const converted = await convertManifestCode(code)
      replaceGithubApp(converted)
      // Mandatory after ANY App change: tokens are cached by installation id,
      // and a new App mints tokens that a stale cache would shadow for an hour.
      clearTokenCache()
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
    ({ body, redirect, status }) => {
      if (body.confirm !== "disconnect") {
        return status(400, "type disconnect to confirm")
      }
      const app = getGithubApp()
      if (!app)
        return redirect(flashUrl("ok", "GitHub was not connected."), 303)

      let unlinked = 0
      for (const installation of listGithubInstallations()) {
        unlinked += clearGitLinkage(String(installation.installationId))
      }
      deleteGithubApp(app.id)
      // Same reason as registration: a revoked App's tokens must not linger in
      // memory for the rest of their hour.
      clearTokenCache()

      logger.info({ appId: app.appId, unlinked }, "disconnected GitHub")
      return redirect(flashUrl("ok", "GitHub is disconnected."), 303)
    },
    { body: t.Object({ confirm: t.String(), csrf: t.String() }) },
  )

// --------------------------------------------------------------- helpers

interface GitPickerRepo {
  fullName: string
  defaultBranch: string
  private: boolean
}

interface GitPickerInstallation {
  installationId: number
  accountLogin: string
  repos: GitPickerRepo[]
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
 * Rendered server-side at page load, one API call per installation, rather
 * than from a client fetch endpoint — the UI is a view of server state and
 * this project does not add an XHR API to populate a <select>.
 *
 * Each call is isolated: an installation the user revoked on GitHub still has
 * a row here, and its token mint 404s. Letting that reject would take down the
 * whole project page for a resource that has nothing to do with GitHub.
 *
 * Caveat, surfaced in the template: listInstallationRepos paginates to
 * completion at 100/page, so an installation granting several hundred
 * repositories makes this page slow and its HTML large. The fix is to scope
 * the installation to fewer repositories, not to fetch from the client.
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
          repos: await listInstallationRepos(installation.installationId),
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

interface LayoutOptions {
  activeProjectId?: string
  activeEnvironmentId?: string
  activeSettings?: boolean
  wide?: boolean
}

function layout(
  session: SessionUser | null,
  title: string,
  options: LayoutOptions = {},
) {
  return {
    title,
    user: session ? { email: session.email } : null,
    csrf: session?.csrfToken ?? "",
    // Built per request and never retained — see navTree()'s comment. Guarded
    // on the session because the layout only draws the sidebar for a signed-in
    // user, so an anonymous render would query for nothing.
    nav: session ? navTree() : [],
    activeProjectId: options.activeProjectId,
    activeEnvironmentId: options.activeEnvironmentId,
    activeSettings: options.activeSettings,
    wide: options.wide,
  }
}

function uiState(
  desired: "running" | "stopped",
  containerId: string | null,
): string {
  if (desired === "stopped") return "stopped"
  return containerId ? "healthy" : "queued"
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

import { getDeployment, getResource } from "../db/queries.ts"
import { deployLogTail } from "../events.ts"

function deploymentWithResource(id: string) {
  const deployment = getDeployment(id)
  if (!deployment) return null
  const resource = getResource(deployment.resourceId)
  if (!resource) return null
  return { deployment, resource }
}

function deployLines(deploymentId: string): string[] {
  return deployLogTail(deploymentId)
}
