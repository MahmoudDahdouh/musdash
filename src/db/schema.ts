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
 * Mirrors migrations/0001_init.sql. The SQL is authoritative — Drizzle is a
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
    kind: text("kind").notNull().$type<"image">(),
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
    createdAt: text("created_at").notNull(),
  },
  (t) => [unique().on(t.environmentId, t.name)],
)

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
    trigger: text("trigger")
      .notNull()
      .$type<"manual" | "rollback" | "reconcile">(),
    error: text("error"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
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
export type JobType =
  "deploy" | "stop" | "remove" | "prune_images" | "ensure_caddy"

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
