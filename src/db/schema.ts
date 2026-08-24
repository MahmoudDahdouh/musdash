import { relations } from "drizzle-orm"
import {
  blob,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core"

/**
 * Mirrors migrations/*.sql. The SQL is authoritative — Drizzle is a
 * query builder here, not a migration generator (PHASES.md §2 rules out
 * migration DSL beyond the basics).
 */

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
})

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  csrfToken: text("csrf_token").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
})

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
})

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [unique().on(t.projectId, t.name)],
)

export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().$type<ResourceKind>(),
    /**
     * What this resource is built or pulled FROM, by kind:
     *   image -> { image: "nginx:alpine" }
     *   git   -> { repo, branch, pack, dockerfilePath, buildContext }
     *
     * For a git resource this describes the REPOSITORY and never the image a
     * build produced — see builtImage.
     */
    sourceJson: text("source_json").notNull(),
    desiredState: text("desired_state")
      .notNull()
      .$type<"running" | "stopped">(),
    containerPort: integer("container_port"),
    memoryLimitMb: integer("memory_limit_mb").notNull().default(512),
    healthPath: text("health_path"),
    containerId: text("container_id"),
    currentDeploymentId: text("current_deployment_id"),
    previousImage: text("previous_image"),

    // --- git source (kind = "git") -------------------------------------
    gitInstallationId: text("git_installation_id"),
    /** "owner/name". */
    gitRepo: text("git_repo"),
    gitBranch: text("git_branch"),
    buildPack: text("build_pack").$type<"dockerfile" | "railpack" | null>(),
    dockerfilePath: text("dockerfile_path"),
    buildContext: text("build_context"),
    autoDeploy: integer("auto_deploy").notNull().default(1),
    registryCredentialId: text("registry_credential_id"),
    /**
     * The tag the last successful build produced, for a git resource.
     *
     * Deliberately its own column rather than being written into sourceJson:
     * resourceImage() reads sourceJson.image, so a built tag stored there would
     * make a git resource read as an image resource on its next deploy and stop
     * rebuilding — silently, and only noticed when a push does not take effect.
     */
    builtImage: text("built_image"),

    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(t.environmentId, t.name),
    index("idx_resources_git_repo").on(t.gitRepo, t.gitBranch),
  ],
)

export type ResourceKind = "image" | "git"

export type DeploymentStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled"

export const deployments = sqliteTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    status: text("status").notNull().$type<DeploymentStatus>(),
    image: text("image").notNull(),
    // deployments.trigger is plain TEXT with no CHECK constraint
    // (0001_init.sql:56 is a comment), so widening this union needs no
    // migration — same as jobs.type below.
    trigger: text("trigger")
      .notNull()
      .$type<"manual" | "rollback" | "reconcile" | "webhook">(),
    error: text("error"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),

    // Commit metadata, present only for a deploy triggered from a repository.
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    commitAuthor: text("commit_author"),

    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_deploy_resource").on(t.resourceId, t.createdAt)],
)

export const envVars = sqliteTable(
  "env_vars",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // mode:"buffer" is required — the default ("json") would store text and
    // break the STRICT BLOB column.
    valueEncrypted: blob("value_encrypted", { mode: "buffer" })
      .notNull()
      .$type<Buffer>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [unique().on(t.resourceId, t.key)],
)

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(),
  resourceId: text("resource_id")
    .notNull()
    .references(() => resources.id, { onDelete: "cascade" }),
  host: text("host").notNull().unique(),
  isAuto: integer("is_auto").notNull().default(0),
  createdAt: text("created_at").notNull(),
})

export type JobStatus = "pending" | "leased" | "done" | "failed"
// jobs.type is a plain TEXT column with no CHECK constraint, so widening this
// union needs no migration.
export type JobType =
  | "deploy"
  | "stop"
  | "remove"
  | "prune_images"
  | "ensure_caddy"
  | "ensure_buildkit"

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull().$type<JobType>(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().$type<JobStatus>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: text("run_after").notNull(),
    leasedUntil: text("leased_until"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_jobs_claim").on(t.status, t.runAfter)],
)

/**
 * The one GitHub App this instance registered, via the manifest flow.
 *
 * `appId` is GitHub's numeric App id. Do not confuse it with
 * githubInstallations.appId, which is a foreign key to THIS table's ULID `id` —
 * the two columns share a name in the SQL and mean entirely different things.
 *
 * The three `*Enc` columns are AES-256-GCM at rest under the same key as env var
 * values. mode:"buffer" is required — the default ("json") stores text and
 * breaks the STRICT BLOB column.
 */
export const githubApps = sqliteTable("github_apps", {
  id: text("id").primaryKey(),
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  clientId: text("client_id").notNull(),
  clientSecretEnc: blob("client_secret_enc", { mode: "buffer" })
    .notNull()
    .$type<Buffer>(),
  privateKeyEnc: blob("private_key_enc", { mode: "buffer" })
    .notNull()
    .$type<Buffer>(),
  webhookSecretEnc: blob("webhook_secret_enc", { mode: "buffer" })
    .notNull()
    .$type<Buffer>(),
  createdAt: text("created_at").notNull(),
})

/**
 * Where the App is installed. `installationId` is GitHub's number for the
 * installation and is what mints an access token; `appId` here is the FK to
 * githubApps.id, NOT a GitHub App id.
 */
export const githubInstallations = sqliteTable("github_installations", {
  id: text("id").primaryKey(),
  appId: text("app_id")
    .notNull()
    .references(() => githubApps.id, { onDelete: "cascade" }),
  installationId: integer("installation_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  createdAt: text("created_at").notNull(),
})

/**
 * Credentials for a private image registry. Defined because migration 0002
 * creates the table; nothing reads it yet — private registries are their own
 * slice.
 */
export const registryCredentials = sqliteTable("registry_credentials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  registryUrl: text("registry_url").notNull(),
  username: text("username").notNull(),
  passwordEnc: blob("password_enc", { mode: "buffer" })
    .notNull()
    .$type<Buffer>(),
  createdAt: text("created_at").notNull(),
})

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const projectRelations = relations(projects, ({ many }) => ({
  environments: many(environments),
}))

export const environmentRelations = relations(
  environments,
  ({ one, many }) => ({
    project: one(projects, {
      fields: [environments.projectId],
      references: [projects.id],
    }),
    resources: many(resources),
  }),
)

export const resourceRelations = relations(resources, ({ one, many }) => ({
  environment: one(environments, {
    fields: [resources.environmentId],
    references: [environments.id],
  }),
  deployments: many(deployments),
  envVars: many(envVars),
  domains: many(domains),
}))

export type User = typeof users.$inferSelect
export type Project = typeof projects.$inferSelect
export type Environment = typeof environments.$inferSelect
export type Resource = typeof resources.$inferSelect
export type Deployment = typeof deployments.$inferSelect
export type EnvVar = typeof envVars.$inferSelect
export type Domain = typeof domains.$inferSelect
export type Job = typeof jobs.$inferSelect
export type Session = typeof sessions.$inferSelect
export type GithubApp = typeof githubApps.$inferSelect
export type GithubInstallation = typeof githubInstallations.$inferSelect
export type RegistryCredential = typeof registryCredentials.$inferSelect
