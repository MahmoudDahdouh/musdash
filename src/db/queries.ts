import { and, desc, eq, sql } from "drizzle-orm"
import { decrypt, encrypt } from "../crypto.ts"
import { interpolate } from "../env/interpolate.ts"
import { nowIso, ulid } from "../ids.ts"
import { orm } from "./drizzle.ts"
import { db } from "./index.ts"
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
  sharedEnvVars,
  type Deployment,
  type DeploymentStatus,
  type Domain,
  type Environment,
  type EnvScope,
  type GithubApp,
  type GithubInstallation,
  type Project,
  type Resource,
  type SharedEnvVar,
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

/**
 * The resources a push to (repo, branch) should redeploy.
 *
 * Filtered in SQL rather than in TypeScript: this runs on GitHub's clock, which
 * gives the whole delivery 10 seconds, and loading every resource to filter
 * four fields in a loop is the shape that stops being fine at exactly the
 * moment someone has enough resources to care. Uses idx_resources_git_repo,
 * which migration 0002 created and which has had no reader until now.
 *
 * Casing: the repository name is compared LOWER-CASED on both sides. GitHub
 * preserves the owner's chosen casing in repository.full_name, and a user
 * typing "MyOrg/MyApp" into the create form must still match a push reported as
 * "myorg/myapp". The branch is compared EXACTLY, because git refs are
 * case-sensitive — `Main` is genuinely a different branch from `main`.
 *
 * The cost is that lower(git_repo) is not sargable, so the index serves the
 * branch predicate rather than acting as an equality seek on the repo. At tens
 * of resources that is irrelevant, and a silent no-op on a case mismatch is far
 * more expensive than a scan of a small table.
 */
export function resourcesForPush(repo: string, branch: string): Resource[] {
  return orm
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.kind, "git"),
        sql`lower(${resources.gitRepo}) = ${repo.toLowerCase()}`,
        eq(resources.gitBranch, branch),
        eq(resources.autoDeploy, 1),
        NOT_DELIBERATELY_STOPPED,
      ),
    )
    .all()
}

/**
 * "Not deliberately stopped" — which is NOT the same as desiredState='running'.
 *
 * desiredState has exactly three writers, and between them they overload
 * 'stopped' with two different meanings:
 *   - createResource / createGitResource write 'stopped' at creation
 *   - runDeploy writes 'running' only after a deploy SUCCEEDS (deploy.ts:230-231)
 *   - runStop writes 'stopped' when the user presses Stop (jobs/index.ts:42)
 *
 * So a brand-new resource and a resource the user switched off are
 * indistinguishable by desiredState alone. Filtering on 'running' meant the
 * headline feature silently did nothing on the most common path there is:
 * create a resource from the picker, push, and nothing happens — while the UI
 * shows auto-deploy ticked and the webhook logs "resources: 0".
 *
 * currentDeploymentId is the signal that separates them. It is NULL at creation
 * and is written only alongside desiredState='running' by a successful deploy,
 * so "NULL" means precisely "has never deployed successfully" and can never
 * mean "was stopped". A deliberately stopped resource has a non-NULL
 * currentDeploymentId from its earlier success and is therefore still excluded
 * — pressing Stop must keep a resource stopped no matter who pushes.
 *
 * Written as a named constant rather than inline because the distinction is
 * the point and an inline `or(...)` reads like a widened filter.
 */
const NOT_DELIBERATELY_STOPPED = sql`(${resources.desiredState} = 'running' OR ${resources.currentDeploymentId} IS NULL)`

export function setAutoDeploy(resourceId: string, enabled: boolean): void {
  updateResource(resourceId, { autoDeploy: enabled ? 1 : 0 })
}

/**
 * NULLs gitInstallationId on every resource pointing at a given installation.
 *
 * There is no foreign key from resources.git_installation_id to
 * github_installations (0002_github.sql:37 declares it as a bare TEXT column),
 * so deleting an installation otherwise leaves a stale numeric id behind. That
 * does not fail here — it fails as a 404 from GitHub at the next deploy, long
 * after the uninstall that caused it. Returns the number of rows affected.
 *
 * The id is GitHub's integer as a decimal string, matching what the column
 * holds; see the create handler for why that representation was chosen.
 */
export function clearGitLinkage(installationId: string): number {
  // Counted before the update rather than read from a change count: Drizzle's
  // bun-sqlite driver returns void from .run(), and reaching for the raw
  // Database here to get `.changes` would put a second way of writing this
  // table alongside the ORM for the sake of one integer. Same connection, same
  // synchronous block, so nothing can write between the two statements.
  const affected = countResourcesForInstallation(installationId)
  orm
    .update(resources)
    .set({ gitInstallationId: null })
    .where(eq(resources.gitInstallationId, installationId))
    .run()
  return affected
}

function countResourcesForInstallation(installationId: string): number {
  return (
    orm
      .select({ n: sql<number>`count(*)` })
      .from(resources)
      .where(eq(resources.gitInstallationId, installationId))
      .get()?.n ?? 0
  )
}

/** Resources whose gitInstallationId is set, for the disconnect warning. */
export function countLinkedGitResources(): number {
  return (
    orm
      .select({ n: sql<number>`count(*)` })
      .from(resources)
      .where(sql`${resources.gitInstallationId} IS NOT NULL`)
      .get()?.n ?? 0
  )
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

/**
 * Removes a deployment row outright.
 *
 * Only for a row whose job was never queued — a coalesced push whose bucket
 * already held one. A row with no job behind it shows as a deploy stuck at
 * "queued" forever, which is worse than no row at all. Never call this on a
 * deployment that ran: history is the point of the table.
 */
export function deleteDeployment(id: string): void {
  orm.delete(deployments).where(eq(deployments.id, id)).run()
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

/** One variable as it arrives from a form, before encryption. */
export interface EnvVarInput {
  key: string
  value: string
  scope: EnvScope
}

/** Which level a resolved variable came from. */
export type EnvOrigin = "project" | "environment" | "resource"

/**
 * One resolved key, WITHOUT its value.
 *
 * Deliberately no `value` field: this is what the Env tab renders, and a shape
 * that cannot carry a secret cannot leak one.
 */
export interface ResolvedEnvKey {
  key: string
  scope: EnvScope
  /** The level that won. */
  origin: EnvOrigin
  /** Lower-precedence levels this key is also defined at, in merge order. */
  overrides: EnvOrigin[]
}

/**
 * The plaintext maps a deploy needs. Callers must never log either — pass them
 * to the container spec and the build args and nowhere else.
 */
export interface ResolvedEnv {
  /** Delivered to the container. */
  runtime: Record<string, string>
  /** Delivered to the build as build args. */
  build: Record<string, string>
  /**
   * Every value at every scope, deduped — the redaction set.
   *
   * Includes build-only values that never appear in `runtime`, because the
   * deploy stream carries build output: a set derived from `runtime` alone
   * would print a build-only secret verbatim.
   */
  secrets: string[]
}

export function setEnvVars(resourceId: string, vars: EnvVarInput[]): void {
  // Replace wholesale: the UI edits the full set in one form, so a diff would
  // only add a way for the two to disagree.
  //
  // In a transaction because the delete and the inserts must not be separable:
  // a throw between them (a CryptoError on a corrupt key, a full disk) would
  // otherwise leave the resource with NO variables, and the next deploy would
  // start a container with an empty environment — an app that boots broken
  // rather than one that fails to boot.
  const tx = db.transaction(() => {
    orm.delete(envVars).where(eq(envVars.resourceId, resourceId)).run()
    const now = nowIso()
    for (const v of vars) {
      orm
        .insert(envVars)
        .values({
          id: ulid(),
          resourceId,
          key: v.key,
          valueEncrypted: encrypt(v.value),
          scope: v.scope,
          createdAt: now,
        })
        .run()
    }
  })
  tx()
}

/** Identifies which level a set of shared variables belongs to. */
export type SharedEnvOwner = { projectId: string } | { environmentId: string }

function ownerWhere(owner: SharedEnvOwner) {
  return "projectId" in owner
    ? eq(sharedEnvVars.projectId, owner.projectId)
    : eq(sharedEnvVars.environmentId, owner.environmentId)
}

export function setSharedEnvVars(
  owner: SharedEnvOwner,
  vars: EnvVarInput[],
): void {
  // Same wholesale-replace and same transaction rationale as setEnvVars.
  const tx = db.transaction(() => {
    orm.delete(sharedEnvVars).where(ownerWhere(owner)).run()
    const now = nowIso()
    for (const v of vars) {
      orm
        .insert(sharedEnvVars)
        .values({
          id: ulid(),
          projectId: "projectId" in owner ? owner.projectId : null,
          environmentId: "environmentId" in owner ? owner.environmentId : null,
          key: v.key,
          valueEncrypted: encrypt(v.value),
          scope: v.scope,
          createdAt: now,
        })
        .run()
    }
  })
  tx()
}

/** Keys and scopes for one shared level. Values never leave the database. */
export function listSharedEnvKeys(
  owner: SharedEnvOwner,
): Array<{ key: string; scope: EnvScope }> {
  return orm
    .select({ key: sharedEnvVars.key, scope: sharedEnvVars.scope })
    .from(sharedEnvVars)
    .where(ownerWhere(owner))
    .orderBy(sharedEnvVars.key)
    .all()
}

/** The three levels in precedence order, lowest first. */
function mergeLevels<T>(
  levels: Array<{ origin: EnvOrigin; rows: Array<{ key: string } & T> }>,
): Map<string, { origin: EnvOrigin; overrides: EnvOrigin[] } & T> {
  const merged = new Map<
    string,
    { origin: EnvOrigin; overrides: EnvOrigin[] } & T
  >()
  for (const level of levels) {
    for (const row of level.rows) {
      const prior = merged.get(row.key)
      // Overrides are accumulated during the merge, not recomputed afterwards:
      // a later level displaces an earlier one, and the displaced level is
      // exactly what the UI needs to show.
      const overrides = prior ? [...prior.overrides, prior.origin] : []
      merged.set(row.key, { ...row, origin: level.origin, overrides })
    }
  }
  return merged
}

/**
 * Resolves project → environment → resource for a deploy, last level winning.
 *
 * Scope belongs to the winning definition, not to a union across levels: a
 * resource-level FOO marked 'runtime' overriding a project-level FOO marked
 * 'build' is runtime-only. Anything else would let a lower level silently
 * widen where a secret is delivered.
 *
 * Throws EnvInterpolationError / EnvSelfReferenceError for a bad ${VAR}.
 */
export function resolveEnvVars(resourceId: string): ResolvedEnv {
  const ctx = getResourceContext(resourceId)
  if (!ctx) throw new Error(`resource ${resourceId} no longer exists`)

  const merged = mergeLevels<{ valueEncrypted: Buffer; scope: EnvScope }>([
    {
      origin: "project",
      rows: orm
        .select({
          key: sharedEnvVars.key,
          valueEncrypted: sharedEnvVars.valueEncrypted,
          scope: sharedEnvVars.scope,
        })
        .from(sharedEnvVars)
        .where(eq(sharedEnvVars.projectId, ctx.project.id))
        .all(),
    },
    {
      origin: "environment",
      rows: orm
        .select({
          key: sharedEnvVars.key,
          valueEncrypted: sharedEnvVars.valueEncrypted,
          scope: sharedEnvVars.scope,
        })
        .from(sharedEnvVars)
        .where(eq(sharedEnvVars.environmentId, ctx.environment.id))
        .all(),
    },
    {
      origin: "resource",
      rows: orm
        .select({
          key: envVars.key,
          valueEncrypted: envVars.valueEncrypted,
          scope: envVars.scope,
        })
        .from(envVars)
        .where(eq(envVars.resourceId, resourceId))
        .all(),
    },
  ])

  const flat: Record<string, string> = {}
  for (const [key, row] of merged) flat[key] = decrypt(row.valueEncrypted)

  // Interpolation runs across every key regardless of scope, so a build
  // variable may reference a runtime one and vice versa. This is why it
  // happens after the merge and before the split.
  const expanded = interpolate(flat)

  const runtime: Record<string, string> = {}
  const build: Record<string, string> = {}
  for (const [key, row] of merged) {
    const value = expanded[key] ?? ""
    if (row.scope !== "build") runtime[key] = value
    if (row.scope !== "runtime") build[key] = value
  }

  return {
    runtime,
    build,
    secrets: [...new Set(Object.values(expanded))],
  }
}

/**
 * The same merge as resolveEnvVars, for the UI — but it never decrypts, so no
 * plaintext can reach a template.
 */
export function resolveEnvKeys(resourceId: string): ResolvedEnvKey[] {
  const ctx = getResourceContext(resourceId)
  if (!ctx) return []

  const merged = mergeLevels<{ scope: EnvScope }>([
    {
      origin: "project",
      rows: orm
        .select({ key: sharedEnvVars.key, scope: sharedEnvVars.scope })
        .from(sharedEnvVars)
        .where(eq(sharedEnvVars.projectId, ctx.project.id))
        .all(),
    },
    {
      origin: "environment",
      rows: orm
        .select({ key: sharedEnvVars.key, scope: sharedEnvVars.scope })
        .from(sharedEnvVars)
        .where(eq(sharedEnvVars.environmentId, ctx.environment.id))
        .all(),
    },
    {
      origin: "resource",
      rows: orm
        .select({ key: envVars.key, scope: envVars.scope })
        .from(envVars)
        .where(eq(envVars.resourceId, resourceId))
        .all(),
    },
  ])

  return [...merged.entries()]
    .map(([key, row]) => ({
      key,
      scope: row.scope,
      origin: row.origin,
      overrides: row.overrides,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
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
  EnvScope,
  SharedEnvVar,
  GithubApp,
  GithubInstallation,
  Project,
  Resource,
}
