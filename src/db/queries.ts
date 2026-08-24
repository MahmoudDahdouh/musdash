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
  githubApps,
  githubInstallations,
  resources,
  settings,
  type Deployment,
  type DeploymentStatus,
  type Domain,
  type Environment,
  type GithubApp,
  type GithubInstallation,
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
    ...NO_GIT_SOURCE,
    createdAt: nowIso(),
  }
  orm.insert(resources).values(resource).run()
  return resource
}

/** The git columns, all empty. An image resource carries none of them. */
const NO_GIT_SOURCE = {
  gitInstallationId: null,
  gitRepo: null,
  gitBranch: null,
  buildPack: null,
  dockerfilePath: null,
  buildContext: null,
  autoDeploy: 1,
  registryCredentialId: null,
  builtImage: null,
} as const

export interface NewGitResource {
  environmentId: string
  name: string
  repo: string
  branch: string
  pack: "dockerfile" | "railpack"
  dockerfilePath?: string | null
  buildContext?: string | null
  installationId?: string | null
  containerPort?: number | null
  healthPath?: string | null
  memoryLimitMb: number
}

/**
 * A resource built from a repository.
 *
 * sourceJson holds the REPOSITORY, never an image — see resourceImage(). The
 * git columns duplicate part of it so the webhook handler can find affected
 * resources with an indexed query rather than parsing JSON for every row.
 */
export function createGitResource(input: NewGitResource): Resource {
  const resource: Resource = {
    id: ulid(),
    environmentId: input.environmentId,
    name: input.name,
    kind: "git",
    sourceJson: JSON.stringify({
      repo: input.repo,
      branch: input.branch,
      pack: input.pack,
      ...(input.dockerfilePath ? { dockerfilePath: input.dockerfilePath } : {}),
      ...(input.buildContext ? { buildContext: input.buildContext } : {}),
    }),
    desiredState: "stopped",
    containerPort: input.containerPort ?? null,
    memoryLimitMb: input.memoryLimitMb,
    healthPath: input.healthPath ?? null,
    containerId: null,
    currentDeploymentId: null,
    previousImage: null,
    gitInstallationId: input.installationId ?? null,
    gitRepo: input.repo,
    gitBranch: input.branch,
    buildPack: input.pack,
    dockerfilePath: input.dockerfilePath ?? null,
    buildContext: input.buildContext ?? null,
    autoDeploy: 1,
    registryCredentialId: null,
    builtImage: null,
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

/** The repository spec of a git resource. Never holds a built image. */
export interface GitSource {
  repo: string
  branch: string
  pack: "dockerfile" | "railpack"
  dockerfilePath?: string
  buildContext?: string
}

export function gitSource(resource: Resource): GitSource | null {
  if (resource.kind !== "git") return null
  const src = JSON.parse(resource.sourceJson) as Partial<GitSource>
  if (!src.repo || !src.branch) return null
  return {
    repo: src.repo,
    branch: src.branch,
    pack: src.pack ?? "railpack",
    dockerfilePath: src.dockerfilePath,
    buildContext: src.buildContext,
  }
}

/**
 * The image this resource should run right now.
 *
 * Branches on kind, and must keep doing so. An image resource carries its
 * reference in sourceJson; a git resource has no image until a build has
 * produced one, and its sourceJson describes the repository instead. Reading
 * sourceJson.image for both would return "" for every git resource, which the
 * reconciler treats as "nothing to deploy" — a resource that silently never
 * comes back after its container is removed.
 */
export function resourceImage(resource: Resource): string {
  if (resource.kind === "git") return resource.builtImage ?? ""
  const src = JSON.parse(resource.sourceJson) as { image?: string }
  return src.image ?? ""
}

/**
 * Every image reference the prune job must not delete: what each resource is
 * running now, plus its rollback target.
 *
 * A rollback target is referenced only by this row — no container holds it, so
 * Docker sees it as unused and would happily reclaim it, silently turning the
 * rollback button into a re-pull that fails offline or against a deleted tag.
 *
 * This matters more for a built image than a pulled one, and the difference is
 * absolute: a registry image that is pruned can be pulled again, while a built
 * image exists nowhere but this daemon. Pruning one destroys the rollback
 * target permanently. resourceImage() returns builtImage for a git resource, so
 * the current build is covered by the same line that covers a pulled image.
 */
export function listProtectedImages(): string[] {
  const keep = new Set<string>()
  for (const resource of listAllResources()) {
    const current = resourceImage(resource)
    if (current) keep.add(current)
    if (resource.previousImage) keep.add(resource.previousImage)
  }
  return [...keep]
}

/**
 * Points an IMAGE resource at a different registry reference.
 *
 * Rejects a git resource rather than silently succeeding: sourceJson holds the
 * repository for those, and overwriting it with an image is exactly the failure
 * that makes a git resource stop rebuilding.
 */
export function setResourceImage(id: string, image: string): void {
  const resource = getResource(id)
  if (resource && resource.kind !== "image") {
    throw new Error(
      `resource ${id} is a ${resource.kind} resource, not an image`,
    )
  }
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
  commitSha?: string | null
  commitMessage?: string | null
  commitAuthor?: string | null
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
    commitSha: args.commitSha ?? null,
    commitMessage: args.commitMessage ?? null,
    commitAuthor: args.commitAuthor ?? null,
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

/**
 * Removes a setting outright.
 *
 * Distinct from setSetting(key, "") on purpose: the manifest state nonce is
 * consumed by deletion, and a sentinel empty string would still be a row that a
 * replayed callback could read and compare against.
 */
export function deleteSetting(key: string): void {
  orm.delete(settings).where(eq(settings.key, key)).run()
}

// ------------------------------------------------------------- github app

/**
 * The one registered GitHub App, or undefined when GitHub is not connected.
 *
 * There is at most one row: a second App would silently orphan every existing
 * installation, whose app_id points at the first. insertGithubApp enforces it.
 */
export function getGithubApp(): GithubApp | undefined {
  return orm.select().from(githubApps).get()
}

export interface NewGithubApp {
  appId: number
  slug: string
  clientId: string
  clientSecret: string
  privateKey: string
  webhookSecret: string
}

/**
 * Stores a freshly registered App, encrypting all three secrets.
 *
 * Encryption lives here rather than at the call site, exactly as setEnvVars
 * does: the number of places that touch a plaintext secret stays countable, and
 * a caller cannot forget.
 */
export function insertGithubApp(input: NewGithubApp): GithubApp {
  if (getGithubApp()) {
    throw new Error(
      "a GitHub App is already registered; disconnect it before registering another",
    )
  }
  const row: GithubApp = {
    id: ulid(),
    appId: input.appId,
    slug: input.slug,
    clientId: input.clientId,
    clientSecretEnc: encrypt(input.clientSecret),
    privateKeyEnc: encrypt(input.privateKey),
    webhookSecretEnc: encrypt(input.webhookSecret),
    createdAt: nowIso(),
  }
  orm.insert(githubApps).values(row).run()
  return row
}

/** The App's RSA private key, decrypted. Never log the return value. */
export function getAppPrivateKey(): string | null {
  const app = getGithubApp()
  return app ? decrypt(app.privateKeyEnc) : null
}

/** The webhook signing secret, decrypted. Checkpoint 5 verifies against it. */
export function getWebhookSecret(): string | null {
  const app = getGithubApp()
  return app ? decrypt(app.webhookSecretEnc) : null
}

/** Removes the App and, by cascade, every installation of it. */
export function deleteGithubApp(id: string): void {
  orm.delete(githubApps).where(eq(githubApps.id, id)).run()
}

// --------------------------------------------------- github installations

export interface NewInstallation {
  appRowId: string
  installationId: number
  accountLogin: string
}

/**
 * Records an installation, or refreshes the login of one already known.
 *
 * Keyed on GitHub's installation_id, which is UNIQUE: the same installation
 * re-reported by a sync or a webhook must update rather than collide.
 */
export function upsertInstallation(input: NewInstallation): void {
  orm
    .insert(githubInstallations)
    .values({
      id: ulid(),
      appId: input.appRowId,
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: { accountLogin: input.accountLogin },
    })
    .run()
}

export function listGithubInstallations(): GithubInstallation[] {
  return orm.select().from(githubInstallations).all()
}

export function getInstallation(id: string): GithubInstallation | undefined {
  return orm
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, id))
    .get()
}

export function deleteInstallation(installationId: number): void {
  orm
    .delete(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
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

/** One project with its environments, for the sidebar tree. */
export interface NavProject {
  id: string
  name: string
  environments: { id: string; name: string }[]
}

/**
 * The sidebar tree, built with one joined query regardless of project count.
 *
 * Per-page cost is deliberate: SQLite is in-process, so this is a function
 * call against a memory-mapped file, not a network round trip. Caching the
 * tree would mean holding it — and invalidating it on every create and delete
 * — which trades microseconds for resident memory and a staleness bug.
 */
export function navTree(): NavProject[] {
  const rows = orm
    .select({
      projectId: projects.id,
      projectName: projects.name,
      environmentId: environments.id,
      environmentName: environments.name,
    })
    .from(projects)
    .leftJoin(environments, eq(environments.projectId, projects.id))
    .orderBy(desc(projects.createdAt), environments.createdAt)
    .all()

  const out: NavProject[] = []
  let current: NavProject | undefined
  for (const row of rows) {
    if (!current || current.id !== row.projectId) {
      current = { id: row.projectId, name: row.projectName, environments: [] }
      out.push(current)
    }
    // A leftJoin yields a null environment row for a project that has none.
    if (row.environmentId !== null && row.environmentName !== null) {
      current.environments.push({
        id: row.environmentId,
        name: row.environmentName,
      })
    }
  }
  return out
}

export type {
  Deployment,
  DeploymentStatus,
  Domain,
  Environment,
  GithubApp,
  GithubInstallation,
  Project,
  Resource,
}
