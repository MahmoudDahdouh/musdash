import { and, desc, eq, sql } from "drizzle-orm"
import { decrypt, encrypt } from "../crypto.ts"
import { nowIso, ulid } from "../ids.ts"
import { orm } from "./drizzle.ts"
import {
  deployments,
  domains,
  environments,
  envVars,
  projects,
  resources,
  settings,
  type Deployment,
  type DeploymentStatus,
  type Domain,
  type Environment,
  type Project,
  type Resource,
} from "./schema.ts"

// --------------------------------------------------------------- projects

export function listProjects(): Project[] {
  return orm.select().from(projects).orderBy(desc(projects.createdAt)).all()
}

export function getProject(id: string): Project | undefined {
  return orm.select().from(projects).where(eq(projects.id, id)).get()
}

/** Creating a project always creates a `production` environment (§11). */
export function createProject(name: string, description?: string): Project {
  const project: Project = {
    id: ulid(),
    name,
    description: description ?? null,
    createdAt: nowIso(),
  }
  orm.insert(projects).values(project).run()
  createEnvironment(project.id, "production")
  return project
}

export function deleteProject(id: string): void {
  orm.delete(projects).where(eq(projects.id, id)).run()
}

// ----------------------------------------------------------- environments

export function createEnvironment(
  projectId: string,
  name: string,
): Environment {
  const env: Environment = {
    id: ulid(),
    projectId,
    name,
    createdAt: nowIso(),
  }
  orm.insert(environments).values(env).run()
  return env
}

export function listEnvironments(projectId: string): Environment[] {
  return orm
    .select()
    .from(environments)
    .where(eq(environments.projectId, projectId))
    .orderBy(environments.createdAt)
    .all()
}

export function getEnvironment(id: string): Environment | undefined {
  return orm.select().from(environments).where(eq(environments.id, id)).get()
}

export function deleteEnvironment(id: string): void {
  orm.delete(environments).where(eq(environments.id, id)).run()
}

// --------------------------------------------------------------- resources

export interface NewResource {
  environmentId: string
  name: string
  image: string
  containerPort?: number | null
  healthPath?: string | null
  memoryLimitMb: number
}

export function createResource(input: NewResource): Resource {
  const resource: Resource = {
    id: ulid(),
    environmentId: input.environmentId,
    name: input.name,
    kind: "image",
    sourceJson: JSON.stringify({ image: input.image }),
    desiredState: "stopped",
    containerPort: input.containerPort ?? null,
    memoryLimitMb: input.memoryLimitMb,
    healthPath: input.healthPath ?? null,
    containerId: null,
    currentDeploymentId: null,
    previousImage: null,
    createdAt: nowIso(),
  }
  orm.insert(resources).values(resource).run()
  return resource
}

export function getResource(id: string): Resource | undefined {
  return orm.select().from(resources).where(eq(resources.id, id)).get()
}

export function listResources(environmentId: string): Resource[] {
  return orm
    .select()
    .from(resources)
    .where(eq(resources.environmentId, environmentId))
    .orderBy(resources.createdAt)
    .all()
}

export function listAllResources(): Resource[] {
  return orm.select().from(resources).all()
}

export function listRunningResources(): Resource[] {
  return orm
    .select()
    .from(resources)
    .where(eq(resources.desiredState, "running"))
    .all()
}

export function updateResource(
  id: string,
  patch: Partial<Omit<Resource, "id" | "createdAt">>,
): void {
  orm.update(resources).set(patch).where(eq(resources.id, id)).run()
}

export function deleteResource(id: string): void {
  orm.delete(resources).where(eq(resources.id, id)).run()
}

export function resourceImage(resource: Resource): string {
  const src = JSON.parse(resource.sourceJson) as { image?: string }
  return src.image ?? ""
}

export function setResourceImage(id: string, image: string): void {
  updateResource(id, { sourceJson: JSON.stringify({ image }) })
}

/** Resource plus the environment and project it belongs to, for headers/URLs. */
export interface ResourceContext {
  resource: Resource
  environment: Environment
  project: Project
}

export function getResourceContext(id: string): ResourceContext | undefined {
  const row = orm
    .select({
      resource: resources,
      environment: environments,
      project: projects,
    })
    .from(resources)
    .innerJoin(environments, eq(resources.environmentId, environments.id))
    .innerJoin(projects, eq(environments.projectId, projects.id))
    .where(eq(resources.id, id))
    .get()
  return row ?? undefined
}

// ------------------------------------------------------------- deployments

export function createDeployment(args: {
  resourceId: string
  image: string
  trigger: Deployment["trigger"]
}): Deployment {
  const deployment: Deployment = {
    id: ulid(),
    resourceId: args.resourceId,
    status: "queued",
    image: args.image,
    trigger: args.trigger,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: nowIso(),
  }
  orm.insert(deployments).values(deployment).run()
  return deployment
}

export function getDeployment(id: string): Deployment | undefined {
  return orm.select().from(deployments).where(eq(deployments.id, id)).get()
}

export function listDeployments(resourceId: string, limit = 20): Deployment[] {
  return orm
    .select()
    .from(deployments)
    .where(eq(deployments.resourceId, resourceId))
    .orderBy(desc(deployments.createdAt))
    .limit(limit)
    .all()
}

export function updateDeployment(
  id: string,
  patch: Partial<Omit<Deployment, "id" | "resourceId" | "createdAt">>,
): void {
  orm.update(deployments).set(patch).where(eq(deployments.id, id)).run()
}

export function markDeploymentFailed(id: string, error: string): void {
  updateDeployment(id, {
    status: "failed",
    error,
    finishedAt: nowIso(),
  })
}

/** Any deployment left mid-flight by a crash. */
export function stuckDeployments(): Deployment[] {
  return orm
    .select()
    .from(deployments)
    .where(eq(deployments.status, "running"))
    .all()
}

// ----------------------------------------------------------------- env vars

export function setEnvVars(
  resourceId: string,
  vars: Record<string, string>,
): void {
  // Replace wholesale: the UI edits the full set in one textarea, so a diff
  // would only add a way for the two to disagree.
  orm.delete(envVars).where(eq(envVars.resourceId, resourceId)).run()
  const now = nowIso()
  for (const [key, value] of Object.entries(vars)) {
    orm
      .insert(envVars)
      .values({
        id: ulid(),
        resourceId,
        key,
        valueEncrypted: encrypt(value),
        createdAt: now,
      })
      .run()
  }
}

export function getEnvVarKeys(resourceId: string): string[] {
  return orm
    .select({ key: envVars.key })
    .from(envVars)
    .where(eq(envVars.resourceId, resourceId))
    .all()
    .map((r) => r.key)
}

/**
 * Decrypts every env var for a resource. Callers must never log the result —
 * pass it to the container spec and nowhere else.
 */
export function getDecryptedEnvVars(
  resourceId: string,
): Record<string, string> {
  const rows = orm
    .select()
    .from(envVars)
    .where(eq(envVars.resourceId, resourceId))
    .all()

  const out: Record<string, string> = {}
  for (const row of rows) out[row.key] = decrypt(row.valueEncrypted)
  return out
}

// ------------------------------------------------------------------ domains

export function addDomain(
  resourceId: string,
  host: string,
  isAuto = false,
): Domain {
  const domain: Domain = {
    id: ulid(),
    resourceId,
    host: host.toLowerCase(),
    isAuto: isAuto ? 1 : 0,
    createdAt: nowIso(),
  }
  orm.insert(domains).values(domain).run()
  return domain
}

export function listDomains(resourceId: string): Domain[] {
  return orm
    .select()
    .from(domains)
    .where(eq(domains.resourceId, resourceId))
    .orderBy(desc(domains.isAuto))
    .all()
}

export function deleteDomain(id: string): void {
  orm.delete(domains).where(eq(domains.id, id)).run()
}

export function domainExists(host: string): boolean {
  return (
    orm
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.host, host.toLowerCase()))
      .get() !== undefined
  )
}

// ----------------------------------------------------------------- settings

export function getSetting(key: string): string | undefined {
  return orm.select().from(settings).where(eq(settings.key, key)).get()?.value
}

export function setSetting(key: string, value: string): void {
  orm
    .insert(settings)
    .values({ key, value, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: nowIso() },
    })
    .run()
}

// -------------------------------------------------------------- aggregates

export interface ResourceSummary {
  resource: Resource
  latestDeployment: Deployment | undefined
  domainCount: number
}

export function summarizeResources(environmentId: string): ResourceSummary[] {
  return listResources(environmentId).map((resource) => ({
    resource,
    latestDeployment: orm
      .select()
      .from(deployments)
      .where(eq(deployments.resourceId, resource.id))
      .orderBy(desc(deployments.createdAt))
      .limit(1)
      .get(),
    domainCount:
      orm
        .select({ n: sql<number>`count(*)` })
        .from(domains)
        .where(eq(domains.resourceId, resource.id))
        .get()?.n ?? 0,
  }))
}

export function countResourcesInProject(projectId: string): number {
  return (
    orm
      .select({ n: sql<number>`count(*)` })
      .from(resources)
      .innerJoin(environments, eq(resources.environmentId, environments.id))
      .where(eq(environments.projectId, projectId))
      .get()?.n ?? 0
  )
}

export function findResourceByNameInEnv(
  environmentId: string,
  name: string,
): Resource | undefined {
  return orm
    .select()
    .from(resources)
    .where(
      and(eq(resources.environmentId, environmentId), eq(resources.name, name)),
    )
    .get()
}

export type {
  Deployment,
  DeploymentStatus,
  Domain,
  Environment,
  Project,
  Resource,
}
