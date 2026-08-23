import { Elysia, t } from "elysia"
import {
  resolveSession,
  SESSION_COOKIE,
  verifyCsrf,
  type SessionUser,
} from "../auth.ts"
import { autoDomainFor } from "../caddy/client.ts"
import { config } from "../config.ts"
import { isValidImageRef, isValidResourceName } from "../docker/client.ts"
import {
  addDomain,
  createEnvironment,
  createProject,
  createResource,
  deleteDomain,
  domainExists,
  findResourceByNameInEnv,
  getEnvironment,
  getEnvVarKeys,
  getProject,
  getResourceContext,
  listDeployments,
  listDomains,
  listEnvironments,
  listProjects,
  listResources,
  resourceImage,
  setEnvVars,
  setResourceImage,
  updateResource,
} from "../db/queries.ts"
import { parseEnvText } from "../env/parse.ts"
import { enqueueDeploy } from "../jobs/deploy.ts"
import { logger } from "../log.ts"
import { tail } from "../logs/buffer.ts"
import { enqueue } from "../queue/index.ts"
import { renderPage } from "../views/render.ts"

const html = (body: string) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })

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

  .get("/p/:projectId", ({ params, session, status }) => {
    const project = getProject(params.projectId)
    if (!project) return status(404, "project not found")

    const environments = listEnvironments(project.id).map((environment) => ({
      environment,
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
          csrf: session?.csrfToken,
          defaultMemoryMb: config.defaultMemoryMb,
        },
        layout(session, project.name),
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
          envKeys: getEnvVarKeys(resource.id),
          // Never render decrypted values back into the page.
          envText: "",
          envError: query.envError ? String(query.envError) : null,
          logs: tail(resource.id, 300),
          csrf: session?.csrfToken,
        },
        layout(session, resource.name),
      ),
    )
  })

  .post("/r/:resourceId/deploy", ({ params, redirect, status }) => {
    const ctx = getResourceContext(params.resourceId)
    if (!ctx) return status(404, "resource not found")
    const image = resourceImage(ctx.resource)
    if (!image) return status(400, "this resource has no image set")

    // Enqueue and redirect immediately — never await Docker in a handler.
    const deploymentId = enqueueDeploy(ctx.resource.id, image, "manual")
    return redirect(`/d/${deploymentId}`, 303)
  })

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

      const parsed = parseEnvText(body.text ?? "")
      if (parsed.errors.length > 0) {
        const msg = encodeURIComponent(parsed.errors.join("; "))
        return redirect(`/r/${ctx.resource.id}?tab=env&envError=${msg}`, 303)
      }
      setEnvVars(ctx.resource.id, parsed.vars)
      return redirect(`/r/${ctx.resource.id}?tab=env`, 303)
    },
    { body: t.Object({ text: t.Optional(t.String()), csrf: t.String() }) },
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
      if (!isValidImageRef(body.image)) {
        return status(400, "that does not look like a valid image reference")
      }

      setResourceImage(ctx.resource.id, body.image)
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
    return html(
      renderPage(
        "deployment",
        {
          deployment: deployment.deployment,
          resource: deployment.resource,
          pill: deployment.deployment.status,
          lines: deployLines(params.deploymentId),
        },
        layout(session, "Deployment"),
      ),
    )
  })

// --------------------------------------------------------------- helpers

function layout(session: SessionUser | null, title: string) {
  return {
    title,
    user: session ? { email: session.email } : null,
    csrf: session?.csrfToken ?? "",
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
