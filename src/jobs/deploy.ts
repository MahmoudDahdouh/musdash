import { isIP } from "node:net"
import { caddy, routeIdFor } from "../caddy/client.ts"
import { CADDY_CONTAINER } from "../caddy/bootstrap.ts"
import { MIGRATE_LABEL } from "../caddy/kernel.ts"
import { CERT_WAIT_MS, waitForCertificate } from "../caddy/tls-probe.ts"
import { BUILD_PLACEHOLDER, isBuiltImageTag } from "../build/images.ts"
import {
  type BuildOptions,
  buildFromSource,
  type FetchedSource,
} from "./build.ts"
import { config } from "../config.ts"
import {
  type ContainerState,
  isValidImageRef,
  LABEL_RESOURCE,
  LABEL_ROLE,
  managedLabels,
} from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import { db } from "../db/index.ts"
import {
  commitForImage,
  createDeployment,
  getDeployment,
  getResourceContext,
  gitSource,
  latestDeploymentStatus,
  markDeploymentFailed,
  resolveEnvVars,
  reusableBuilds,
  updateDeployment,
  updateResource,
} from "../db/queries.ts"
import type { Deployment, Resource } from "../db/schema.ts"
import {
  publishDeployLog,
  publishDeployment,
  publishStatus,
} from "../events.ts"
import { isFullCommitSha } from "../github/api.ts"
import { nowIso, shortId } from "../ids.ts"
import { logger, redactGithub, redactValues } from "../log.ts"
import {
  cancelPendingDeploy,
  enqueue,
  findLeasedJobs,
  findPendingJob,
  getJob,
  hasPendingJobAfter,
} from "../queue/index.ts"
import { resourceState } from "../resource-state.ts"
import { startLogStream, stopLogStream } from "../logs/stream.ts"
import { routeHosts } from "./routes.ts"

export interface DeployPayload {
  resourceId: string
  deploymentId: string
  image: string
  /**
   * Deploy the image named above verbatim, without building it.
   *
   * Set for exactly the triggers in REUSES_IMAGE, which name an image that
   * already exists locally. Without it a git resource would rebuild from source
   * on rollback — defeating the button entirely, since the point is to return
   * to the artifact that was running — and the reconciler would rebuild from
   * source every time Docker hiccuped.
   *
   * The inverse matters just as much: a trigger that has no image yet must NOT
   * set this, or the deploy looks for the placeholder tag the row was created
   * with instead of building. See REUSES_IMAGE.
   *
   * For a git resource the image is taken from this server only, never pulled
   * (D60): see step 3 of runDeploy.
   */
  useExistingImage?: boolean
  /**
   * On every job enqueueRedeploy writes, and on no other: the deployment being
   * repeated. Its presence, not its value, is what step 3 of runDeploy and the
   * fold checks (BRANCH_BUILD) key on.
   */
  redeployOf?: string
  /**
   * Git redeploys whose source row recorded a full commit: 40 lowercase hex.
   * Omitted, never null, when there is none.
   */
  pinnedSha?: string
}

/**
 * Logs the process's peak resident set after a deploy.
 *
 * The RAM gate measures idle memory, as specified, so a boot-and-idle run
 * never sees a peak; this line is where one gets recorded on a real host.
 * `peakRssMb` is maxRSS — the process's LIFETIME high-water mark (in KB), not
 * this deploy's. It includes everything since boot, sign-in hashing above all:
 * the 128MB once blamed on a deploy (V-3) was an argon2id block allocated at
 * sign-in, while a deploy with an image pull adds about 5MB (D34). So a jump on
 * this line means the peak rose at some point before the deploy finished, not
 * necessarily during it.
 */
function logPeakRss(
  resourceId: string,
  deploymentId: string,
  outcome: "succeeded" | "failed",
): void {
  logger.info(
    {
      resourceId,
      deploymentId,
      outcome,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    },
    "deploy finished",
  )
}

/** How long to let the old container finish in-flight requests. */
const DRAIN_MS = 10_000

export function containerName(
  resourceId: string,
  deploymentId: string,
): string {
  return `musdash-${shortId(resourceId)}-${shortId(deploymentId)}`
}

/**
 * The deploy pipeline.
 *
 * The ordering at the end is the product's core guarantee and must not be
 * rearranged: the new container is verified healthy, THEN the route is
 * switched, THEN the old container is drained and stopped. Any other order
 * still produces a deploy that looks like it works — it just drops requests
 * every time, and nobody notices until production.
 */
export async function runDeploy(payload: DeployPayload): Promise<void> {
  const { resourceId, deploymentId } = payload
  // Reassigned for a git resource, whose real tag is not known until it builds.
  let image = payload.image
  const ctx = getResourceContext(resourceId)
  if (!ctx) throw new Error(`resource ${resourceId} no longer exists`)
  const { resource, project } = ctx

  // Filled by resolveEnvVars inside the try below, but declared here so that
  // emit/safe exist before resolution runs — a failure DURING resolution is
  // then still redacted. Read through a closure rather than captured by value:
  // lines emitted before resolution simply have nothing to redact yet.
  let secrets: string[] = []
  // Two layers, because they catch different things: redactValues matches the
  // env values known for this resource, while redactGithub pattern-matches
  // credentials minted at runtime — an installation token belongs to no known
  // set and would otherwise print verbatim.
  const safe = (text: string) => redactGithub(redactValues(text, secrets))

  // Redaction lives in emit itself, which is the single point every deploy log
  // line passes through — build output, status lines and error messages alike.
  // Applying it only at individual call sites is one forgotten call away from
  // publishing a secret, and this stream is shown in the browser.
  const emit = (text: string) => {
    publishDeployLog(deploymentId, safe(text))
  }

  // A build that switched a Next.js 16+ app to webpack records BuildKit's cap
  // on the row, for the deployment page's note. Only builds call it, so
  // reuse, rollback and reconcile rows stay null — and "Deploy this again"
  // does not copy it: a redeploy records it only if it rebuilds and switches.
  const recordAutoWebpack = (capMib: number) => {
    updateDeployment(deploymentId, { autoWebpackCapMib: capMib })
  }

  const oldContainerId = resource.containerId
  let newContainerId: string | null = null
  // Whether the route switch was entered, and whether it finished. The failure
  // cleanup differs entirely between the two, so they are tracked separately.
  let routeSwitchAttempted = false
  let routeSwitched = false

  // What is genuinely running right now. The resource row cannot be trusted for
  // this: editing the image in Settings writes the NEW image to the row before
  // this job runs, so reading it here would report the incoming image as the
  // outgoing one and rollback would have nothing to roll back to.
  const outgoingImage = await currentImageOf(oldContainerId)

  try {
    // 1. mark running
    updateDeployment(deploymentId, { status: "running", startedAt: nowIso() })
    publishDeployment({ deploymentId, resourceId, status: "running" })
    publishStatus({ resourceId, state: "deploying" })
    emit(
      image === BUILD_PLACEHOLDER
        ? "Deploying a new build"
        : `Deploying ${image}`,
    )

    // Secrets are decrypted here and must never reach a log line — not on the
    // happy path, not in an error message, not in the deploy stream.
    //
    // Inside the try, deliberately: resolution merges project → environment →
    // resource and expands ${VAR}, and an unresolvable reference throws. Doing
    // this before the try would let that error bypass the catch below: no
    // deploy log line would name the variable, the resource's status would
    // not be restored, and the user would see only the bare error the worker's
    // generic job-failure path copies onto the deployment row.
    const env = resolveEnvVars(resourceId)
    // Every value at every scope, not just the runtime map: a build-only
    // secret never reaches the container, but BuildKit echoes RUN lines into
    // this same stream.
    secrets = env.secrets

    // 2. network
    await docker.ensureNetwork(config.network)
    emit(`Network ${config.network} ready`)

    // 2b. reclaim containers a previous attempt left behind.
    //
    // A deploy whose route switch failed deliberately keeps its healthy
    // container (the old one is still serving, so destroying the new one would
    // throw away work), and the resource row is never repointed at it. Nothing
    // else collects it: the orphan sweep skips containers whose resource row
    // still exists, so without this they accumulate one per failed attempt.
    await reclaimStrays(resourceId, oldContainerId, emit)

    // 3. obtain the image: build it from source (or reuse an identical earlier
    // build), take a built image from this server, or pull it.
    //
    // The ONLY structural change for git resources. Everything from step 4 on
    // is identical for both kinds, which is deliberate: the zero-downtime
    // ordering below is the product's core guarantee, and a second copy of it
    // for git resources would be a second place for it to rot. Every failure
    // here is thrown before a new container exists, so the old one keeps
    // serving untouched.
    if (resource.kind === "git" && payload.redeployOf !== undefined) {
      // "Deploy this again" of a git deployment (D61). Its image if this
      // server still holds it — never pulled, for the reason the rollback
      // branch below gives — otherwise the recorded commit built again.
      // Decided here, not at enqueue: the prune may remove the image while
      // the job waits.
      const pinnedSha = payload.pinnedSha
      if (pinnedSha !== undefined && !isFullCommitSha(pinnedSha)) {
        throw new Error("this redeploy names a malformed commit")
      }
      const sha7 = pinnedSha?.slice(0, 7)
      const candidate = isBuiltImageTag(image) ? image : null
      if (candidate !== null && (await docker.imageExists(candidate))) {
        emit(
          sha7 === undefined
            ? `Using ${candidate} from this server; nothing to build`
            : `Using ${candidate} from this server, built from commit ${sha7}; nothing to build`,
        )
        image = candidate
      } else {
        if (pinnedSha === undefined || sha7 === undefined) {
          throw new Error(
            candidate === null
              ? "this redeploy names neither an image nor a commit"
              : `${candidate} is no longer on this server, and this deployment recorded no commit to build it from. Press Deploy to build the branch.`,
          )
        }
        // Rebuilt only from the repository the commit came from. After a
        // re-link the SHA is only known to belong to the old repository, and
        // asking the new one for it deploys from a source the user no longer
        // points at, or fails with a 422 that reads like a GitHub problem.
        // A row from before git_repo was recorded cannot be checked at all.
        const recordedRepo = getDeployment(deploymentId)?.gitRepo ?? null
        if (recordedRepo === null) {
          throw new Error(
            `Commit ${sha7} has no image on this server, and this deployment is older than musdash's record of which repository a build came from, so it is not built again. Press Deploy to build the branch.`,
          )
        }
        const currentRepo = gitSource(resource)?.repo
        if (
          currentRepo === undefined ||
          recordedRepo.toLowerCase() !== currentRepo.toLowerCase()
        ) {
          throw new Error(
            `Commit ${sha7} has no image on this server, and it was built from ${recordedRepo} while this resource now builds ${currentRepo ?? "no repository"}, so it is not built again. Press Deploy to build the branch.`,
          )
        }
        if (candidate !== null) {
          emit(
            `${candidate} is no longer on this server; building commit ${sha7} again`,
          )
        }
        // The row named the old tag; a rebuild that fails must read "Not
        // built", not an image it never produced (P-2).
        image = BUILD_PLACEHOLDER
        updateDeployment(deploymentId, { image })
        // No reuse: the user asked for this commit, and the only image of it
        // worth reusing was the candidate, which is gone. Commit metadata is
        // written exactly as in the build branch below.
        const built = await buildFromSource(
          resource,
          deploymentId,
          emit,
          env.build,
          env.secrets,
          (commit, record) => {
            updateDeployment(deploymentId, {
              commitSha: commit.sha,
              commitMessage: commit.message,
              commitAuthor: commit.author,
              gitRepo: record.repo,
              buildFingerprint: record.fingerprint,
            })
          },
          { commitSha: pinnedSha, onAutoWebpack: recordAutoWebpack },
        )
        image = built.image
        updateDeployment(deploymentId, { image })
      }
    } else if (resource.kind === "git" && !payload.useExistingImage) {
      const row = getDeployment(deploymentId)
      // Only a push may reuse (D60). A push says "deploy what the branch now
      // holds", and an identical earlier build is exactly that. Deploy is the
      // button a user presses when they want a build — to pick up a changed
      // base image, or because they doubt the last one — so it always builds.
      // MUSDASH_BUILD_NO_CACHE means "build from nothing", which reuse is not.
      const opts: BuildOptions =
        row?.trigger === "webhook" && !config.buildNoCache
          ? {
              reuse: (commit, fingerprint) =>
                findReusableImage(
                  resourceId,
                  deploymentId,
                  commit,
                  fingerprint,
                  emit,
                ),
              onAutoWebpack: recordAutoWebpack,
            }
          : { onAutoWebpack: recordAutoWebpack }
      // Commit metadata is written the moment the source is resolved rather
      // than at enqueue time: resolving it in the HTTP handler would put a
      // GitHub call in a request path, and would record the commit that was
      // current when the button was pressed rather than the one this build
      // used. And before the build rather than after it, so a build that fails
      // still names its commit (P-2). One write, so the row never names a
      // commit without the repository and fingerprint that go with it.
      const built = await buildFromSource(
        resource,
        deploymentId,
        emit,
        env.build,
        env.secrets,
        (commit, record) => {
          updateDeployment(deploymentId, {
            commitSha: commit.sha,
            commitMessage: commit.message,
            commitAuthor: commit.author,
            gitRepo: record.repo,
            buildFingerprint: record.fingerprint,
          })
        },
        opts,
      )
      image = built.image
      // The deployment row is created before the tag exists, so it holds
      // BUILD_PLACEHOLDER until now.
      updateDeployment(deploymentId, { image })
    } else if (resource.kind === "git") {
      // A rollback or reconcile of a git resource: an image this server built.
      // Never pulled. `musdash/<name>:<id>` is an unqualified name, which
      // Docker resolves against docker.io — so a pull would fetch whatever
      // anyone published under that name and run it in place of the user's
      // own build. Present locally, or the deploy fails here and now.
      if (!(await docker.imageExists(image))) {
        throw new Error(
          `${image} is no longer on this server. musdash never pulls a built image from a registry; press Deploy to build the branch again.`,
        )
      }
      emit(`Using ${image} from this server`)
    } else {
      await resolveImage(image, emit, safe)
    }

    // 4/5. create the new container alongside the old one
    const name = containerName(resourceId, deploymentId)
    emit(`Creating container ${name}`)
    newContainerId = await docker.createContainer({
      name,
      image,
      env: env.runtime,
      labels: managedLabels({
        resourceId,
        deploymentId,
        projectId: project.id,
      }),
      networks: [config.network],
      volumes: [],
      memoryLimitBytes: resource.memoryLimitMb * 1024 * 1024,
      restartPolicy: "unless-stopped",
    })

    // 6. start
    await docker.startContainer(newContainerId)
    emit("Container started, waiting for health...")

    // 7. health gate
    await healthGate(
      newContainerId,
      resource.containerPort,
      resource.healthPath,
      emit,
    )
    emit("Health check passed")

    // 8a. switch the route BEFORE touching the old container
    const hosts = routeHosts(resourceId)
    // Hosts this deploy puts on the route for the first time. Stays empty when
    // no route is written, so the certificate wait below never runs then.
    let newHosts: string[] = []

    if (hosts.length > 0 && resource.containerPort) {
      // By NAME, which Caddy resolves through Docker's DNS on the musdash
      // network — never by IP. An IP is only good until the next reboot, when
      // the Engine hands addresses out again: Caddy resumed a route to what was
      // now its own address, proxied every request back into itself, and was
      // too busy to answer the admin call that would have repaired it (L-7).
      // A name can only ever mean this container. The health gate above still
      // dials the IP, because musdash on the host cannot use that DNS (D2).
      const upstream = `${name}:${resource.containerPort}`
      // Flipped immediately before the Caddy call itself, not before the block:
      // everything above this line fails while nothing points at the new
      // container, so it is still safe to remove. Only once the swap is in play
      // does keeping it become the right cleanup, and the two are opposites.
      routeSwitchAttempted = true
      // Said at every switch, not only in the bootstrap log nobody reads: a
      // proxy without the sysctl has a known hole in the zero-downtime
      // guarantee (D30, N-4). Asked of the RUNNING proxy's label, not of the
      // kernel — a proxy created before a kernel upgrade still lacks it. A
      // read-only Docker call, on the queue.
      const proxy = (
        await docker.findContainersByName(CADDY_CONTAINER).catch(() => [])
      )[0]
      if (proxy?.labels[MIGRATE_LABEL] !== "1") {
        emit(
          "Note: the proxy runs without tcp_migrate_req (it needs Linux 5.14+), so a request arriving at " +
            "the instant of the switch may fail. See RUNNING.md.",
        )
      }
      // Only names new to the route get a certificate wait. The previous hosts
      // come from the GET upsertRoute already makes to choose PATCH or PUT, so
      // knowing them costs no admin request (every admin call reloads the whole
      // proxy, D30). A name already on the route has either been issued or is
      // being retried by Caddy on its own; waiting on it again on every
      // redeploy would add up to 30s per deploy for nothing.
      const previousHosts = await caddy.upsertRoute({
        id: routeIdFor(resourceId),
        hosts,
        upstream,
      })
      // An IP literal cannot be sent as SNI, so there is nothing to probe;
      // waiting on one would only burn the whole 30s.
      newHosts = hosts.filter(
        (h) =>
          isIP(h) === 0 &&
          !previousHosts.some((p) => p.toLowerCase() === h.toLowerCase()),
      )
      emit(`Route switched to ${upstream} for ${hosts.join(", ")}`)
    } else {
      if (hosts.length > 0) {
        emit("No container port set — skipping route (set one to expose it)")
      }
      // Nothing to route to, so no route. An earlier deploy's route would
      // otherwise keep dialling the old container, which 8b is about to
      // remove. Best-effort: a missing route is the goal, and a Caddy hiccup
      // here must not fail a deploy whose container is healthy.
      await caddy.deleteRoute(routeIdFor(resourceId)).catch((err: unknown) => {
        logger.warn(
          { resourceId, err: (err as Error).message },
          "could not delete the Caddy route",
        )
      })
    }
    // Only reached if nothing above threw; a failure propagates to the outer
    // catch, which knows to keep the healthy container rather than remove it.
    routeSwitched = true
    // The instant traffic moved, taken once for both branches. The drain below
    // counts from here, not from whenever the certificate wait ends.
    const switchedAt = Date.now()

    // 8a-ii. wait for a first certificate on names new to the route.
    //
    // After the switch, because it cannot come earlier: Caddy runs automatic
    // HTTPS, and issuance for a name starts only once a route's host matcher
    // carries it — which is the write just made. Before 8c, because "Deploy
    // succeeded" reads as "the URL works now", and on a first deploy it did
    // not: the handshake failed until issuance finished.
    //
    // Bounded, and never fatal. A name whose DNS does not point here yet can
    // never be issued, and the deploy itself is fine — traffic has moved to a
    // healthy container. So a miss is reported and the deploy still succeeds.
    if (newHosts.length > 0) {
      await awaitCertificates(resourceId, newHosts, emit)
    }

    // 8b. only now is the old container expendable.
    //
    // Gated on the route switch having SUCCEEDED as well as on there being a
    // distinct old container. Stopping the old one while traffic still points
    // at it is the exact outage the zero-downtime guarantee exists to prevent,
    // and an unreachable Caddy is precisely when that mistake would be made.
    if (routeSwitched && oldContainerId && oldContainerId !== newContainerId) {
      // The drain protects requests the OLD container was already serving, and
      // every one of those started before the switch — nothing new reaches it
      // after. So it is counted from the switch: the certificate wait above
      // already gave them that time, and only the remainder is slept. The stop
      // still lands at least DRAIN_MS after the switch; a wait longer than the
      // drain just means no sleep, never a skipped stop.
      const drainLeft = Math.max(0, DRAIN_MS - (Date.now() - switchedAt))
      if (drainLeft > 0) {
        emit(`Draining old container for ${Math.ceil(drainLeft / 1000)}s...`)
        await Bun.sleep(drainLeft)
      }
      stopLogStream(resourceId)
      await docker.stopContainer(oldContainerId, 10).catch(() => {})
      await docker.removeContainer(oldContainerId, true).catch(() => {})
      emit("Old container removed")
    }

    // 8c. record success
    updateResource(resourceId, {
      containerId: newContainerId,
      currentDeploymentId: deploymentId,
      desiredState: "running",
      // sourceJson describes what the resource is built or pulled FROM, so it
      // is rewritten only for an IMAGE resource. Writing a tag there for a git
      // resource destroys the repository spec, and the resource then reads as
      // an image resource on its next deploy and silently stops rebuilding.
      //
      // Keyed on resource.kind, NOT on whether this deploy built something: a
      // rollback or a reconcile of a git resource deploys an existing tag
      // without building, and keying on that clobbered sourceJson on exactly
      // those paths. Found by rolling back a git resource and reading the row.
      ...(resource.kind === "git"
        ? { builtImage: image }
        : { sourceJson: JSON.stringify({ image }) }),
      // Only remember a genuinely different previous image, so rollback never
      // points at the image already running.
      previousImage:
        outgoingImage && outgoingImage !== image
          ? outgoingImage
          : resource.previousImage,
    })
    updateDeployment(deploymentId, {
      status: "succeeded",
      finishedAt: nowIso(),
    })
    publishDeployment({ deploymentId, resourceId, status: "succeeded" })
    publishStatus({
      resourceId,
      state: "healthy",
      containerId: newContainerId,
    })
    emit("Deploy succeeded")
    logPeakRss(resourceId, deploymentId, "succeeded")

    startLogStream(resourceId, newContainerId)
  } catch (err) {
    const message = safe((err as Error).message)
    logger.error({ resourceId, deploymentId, err: message }, "deploy failed")

    // 9. clean up, and what that means depends on how far the deploy got.
    //
    // Before the route switch (pull, create, start, health gate) the new
    // container is useless: nothing points at it and nothing ever did, so
    // removing it is right.
    //
    // The route switch itself failing is a different situation. The container
    // is HEALTHY — it passed the gate — and only the proxy update failed, which
    // an unreachable or misconfigured Caddy causes routinely. Destroying it
    // there would throw away good work and, with the reconciler redeploying
    // every 30 seconds, do it again on a loop. Keep it, and say plainly that
    // traffic has not moved.
    //
    // The resource row is deliberately NOT pointed at the kept container (8c
    // runs only on success). The reconciler therefore still sees the OLD
    // container running and matching the row, and leaves it alone — no
    // redeploy loop.
    if (newContainerId && !routeSwitchAttempted) {
      await docker.removeContainer(newContainerId, true).catch(() => {})
      // Asked, not assumed: a first deploy, a stopped resource, or a reconcile
      // after the container died has nothing serving, and saying otherwise
      // during an outage sends the reader the wrong way. A container that
      // cannot be inspected is gone.
      const oldRunning = oldContainerId
        ? await docker
            .inspectContainer(oldContainerId)
            .then((s) => s.running)
            .catch(() => false)
        : false
      emit(
        oldRunning
          ? "Removed the failed container; the previous one is still serving"
          : "Removed the failed container. Nothing is serving this resource until a deploy succeeds",
      )
    } else if (newContainerId) {
      emit(
        "The new container is healthy but the route could not be switched, so traffic is unchanged. " +
          "The container was kept; check that Caddy is running, then deploy again.",
      )
    }
    markDeploymentFailed(deploymentId, message)
    publishDeployment({ deploymentId, resourceId, status: "failed" })
    publishStatus({
      resourceId,
      state: oldContainerId ? "healthy" : "failed",
      containerId: oldContainerId,
    })
    emit(`Deploy failed: ${message}`)
    logPeakRss(resourceId, deploymentId, "failed")
    throw err
  }
}

/**
 * Makes the image available locally, preferring a fresh pull.
 *
 * An image built on the box and never pushed anywhere is a legitimate source:
 * `POST /images/create` 404s for it, so an unconditional pull made those
 * resources undeployable.
 *
 * The gate is `imageExists`, deliberately NOT the pull's 404 status. A private
 * image whose registry credentials have lapsed also 404s, and so does a typo'd
 * tag that happens to be absent from the registry. Branching on the status
 * would silently deploy whatever stale copy of that name is sitting in the
 * local store while the user believes they got the registry's current one —
 * exactly the failure this is written to prevent. Asking the daemon "do I
 * actually hold this?" answers the only question that matters, and the log line
 * says plainly that the image was not refreshed.
 *
 * Any pull error qualifies, not just a 404: the Engine also reports failures
 * inside the 200 progress stream, and an unreachable daemon throws too. If the
 * existence probe itself fails, the ORIGINAL pull error is what surfaces — the
 * probe must never mask the reason the pull failed.
 */
async function resolveImage(
  image: string,
  emit: (s: string) => void,
  safe: (s: string) => string,
): Promise<void> {
  emit(`Pulling ${image}...`)
  try {
    await docker.pullImage(image, (line) => emit(safe(line)))
    emit("Image pulled")
    return
  } catch (pullError) {
    let local = false
    try {
      local = await docker.imageExists(image)
    } catch {
      throw pullError
    }
    if (!local) throw pullError

    const reason = safe((pullError as Error).message)
    emit(
      `Pull of ${image} failed (${reason}) — using the local image, which will not be refreshed from a registry`,
    )
  }
}

/**
 * The image of an earlier succeeded build with this fingerprint that is still
 * on this server, or null to build.
 *
 * Asked of Docker rather than trusted from the row: the prune, or a user's
 * `docker rmi`, may have removed it, and a reuse that then failed at create
 * would turn a routine push into a failed deploy. Newest first, so a push
 * reuses the most recent identical build.
 *
 * Any failure to ask means "build": reuse is an optimisation, and a daemon that
 * cannot answer an inspect is no reason to fail a deploy that a build might
 * still complete. The error itself is not logged — the fingerprint must never
 * reach a log line, and neither must anything that could echo it.
 */
async function findReusableImage(
  resourceId: string,
  deploymentId: string,
  commit: FetchedSource,
  fingerprint: string,
  emit: (s: string) => void,
): Promise<string | null> {
  for (const match of reusableBuilds(resourceId, fingerprint)) {
    let present: boolean
    try {
      present = await docker.imageExists(match.image)
    } catch {
      logger.warn(
        { resourceId, deploymentId },
        "could not check for a reusable image; building",
      )
      return null
    }
    if (present) {
      emit(
        `Reusing ${match.image}, already built for commit ${commit.sha.slice(0, 7)} with the same settings; nothing to build`,
      )
      return match.image
    }
  }
  return null
}

/**
 * Removes containers belonging to this resource that are neither the one
 * currently serving nor a sidecar.
 *
 * Only failed attempts leave these behind, so on the common path the loop finds
 * nothing. Best-effort throughout: a deploy must not fail because a leftover
 * from a previous attempt could not be removed.
 */
async function reclaimStrays(
  resourceId: string,
  keepContainerId: string | null,
  emit: (s: string) => void,
): Promise<void> {
  const containers = await docker.listManagedContainers().catch(() => [])
  for (const c of containers) {
    // Never a sidecar — see the identical guard in the reconciler's orphan
    // sweep. A resource deploy must not be able to remove the shared proxy.
    if (c.labels[LABEL_ROLE]) continue
    if (c.labels[LABEL_RESOURCE] !== resourceId) continue
    if (c.id === keepContainerId) continue

    await docker.stopContainer(c.id, 10).catch(() => {})
    await docker.removeContainer(c.id, true).catch(() => {})
    emit("Reclaimed a container left behind by an earlier failed deploy")
  }
}

/** The image the currently-serving container was created from, if any. */
async function currentImageOf(
  containerId: string | null,
): Promise<string | null> {
  if (!containerId) return null
  const containers = await docker.listManagedContainers().catch(() => [])
  return containers.find((c) => c.id === containerId)?.image ?? null
}

/**
 * Waits, under one shared deadline, for the proxy to present a certificate for
 * each of `hosts`, and says per host in the deploy log whether it did.
 *
 * Must never throw. It runs after the route switch, and the outer catch in
 * runDeploy treats any throw past routeSwitchAttempted as a FAILED switch: it
 * would mark a deploy failed whose traffic already moved to a healthy
 * container, and leave the resource row pointing at the old one. So the whole
 * body is caught here and logged, and the deploy carries on.
 *
 * Socket and TLS error text goes to pino only; the deploy log gets the fixed
 * sentences below, through emit, like every other line.
 */
async function awaitCertificates(
  resourceId: string,
  hosts: string[],
  emit: (s: string) => void,
): Promise<void> {
  try {
    emit(`Waiting for a certificate for ${hosts.join(", ")}...`)
    const deadline = Date.now() + CERT_WAIT_MS
    await Promise.all(
      hosts.map((host) =>
        waitForCertificate(host, deadline).then((result) => {
          if (result.ready) {
            emit(
              `Certificate ready for ${host} (${Math.ceil(result.elapsedMs / 1000)}s)`,
            )
            return
          }
          const { reason, detail } = result.last.ok
            ? { reason: undefined, detail: undefined }
            : result.last
          logger.warn(
            { resourceId, host, reason, detail },
            "no certificate for a new host before the deadline",
          )
          emit(
            `No certificate for ${host} after ${CERT_WAIT_MS / 1000}s. Caddy keeps retrying; ` +
              `check that ${host} points at this server and ports 80 and 443 are open.`,
          )
        }),
      ),
    )
  } catch (err) {
    // The name only: this path skips the deploy's redaction, so no message.
    logger.warn(
      { resourceId, errorName: err instanceof Error ? err.name : typeof err },
      "certificate wait failed; continuing the deploy",
    )
  }
}

/**
 * Waits for the new container to be usable, in the precedence §9 defines.
 *
 * musdash runs on the host, so it dials the container's IP rather than its name
 * — Docker's embedded DNS only resolves from inside the network (DECISIONS D2).
 */
async function healthGate(
  containerId: string,
  containerPort: number | null,
  healthPath: string | null,
  emit: (s: string) => void,
): Promise<void> {
  const deadline = Date.now() + config.healthTimeoutSec * 1000

  // (a) explicit HTTP check
  if (healthPath && containerPort) {
    emit(`Polling http://<container>:${containerPort}${healthPath}`)
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `health check did not pass within ${config.healthTimeoutSec}s`,
        )
      }
      const state = await docker.inspectContainer(containerId)
      assertNotRestarted(state)
      if (!state.running) {
        throw new Error(
          `container exited during the health check (code ${state.exitCode})`,
        )
      }
      if (state.ipAddress) {
        try {
          const res = await fetch(
            `http://${state.ipAddress}:${containerPort}${healthPath}`,
            { signal: AbortSignal.timeout(5000) },
          )
          if (res.ok) return
          emit(`Health check returned ${res.status}, retrying...`)
        } catch {
          // Not up yet; keep polling until the deadline.
        }
      }
      await Bun.sleep(1000)
    }
  }

  // (b) the image declares its own HEALTHCHECK
  const initial = await docker.inspectContainer(containerId)
  if (initial.health !== "none") {
    emit("Image declares a HEALTHCHECK, polling docker health...")
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `container did not report healthy within ${config.healthTimeoutSec}s`,
        )
      }
      const state = await docker.inspectContainer(containerId)
      assertNotRestarted(state)
      if (state.health === "healthy") return
      if (state.health === "unhealthy") {
        throw new Error("container reported unhealthy")
      }
      if (!state.running) {
        throw new Error(`container exited (code ${state.exitCode})`)
      }
      await Bun.sleep(1000)
    }
  }

  // (c) fallback: still running after 5 seconds
  emit("No health check configured; requiring 5s of uptime")
  await Bun.sleep(5000)
  const state = await docker.inspectContainer(containerId)
  assertNotRestarted(state)
  if (!state.running) {
    throw new Error(
      `container exited within 5s (code ${state.exitCode}) — check the logs above`,
    )
  }
}

/**
 * Fails the gate for a container Docker has already restarted.
 *
 * The container was created by this deploy moments ago, so any restart means it
 * crashed. `running` alone cannot see that: the Engine reports State.Running as
 * true while it restarts a container under `unless-stopped`, so a crash loop
 * read as up and "succeeded" — and the reconciler, whose container list does
 * report the restarting state, then redeployed it every 30 seconds (L-2).
 */
function assertNotRestarted(state: ContainerState): void {
  if (state.restartCount > 0) {
    throw new Error(
      `container crashed and Docker restarted it (${state.restartCount} ${
        state.restartCount === 1 ? "restart" : "restarts"
      }) — check the logs above`,
    )
  }
}

export type DeployTrigger =
  "manual" | "rollback" | "reconcile" | "webhook" | "redeploy"

/**
 * Triggers that deploy an image which already exists locally.
 *
 * Enumerated rather than derived from `trigger !== "manual"`. That inference
 * was correct while there were three triggers and became silently wrong the
 * moment a fourth was added: a webhook deploy would be handed
 * useExistingImage:true and then look on the server for an image literally
 * named BUILD_PLACEHOLDER — which the deployment row carries until a build
 * resolves the real tag — instead of building.
 *
 * Adding a trigger now means choosing a side, instead of inheriting an answer
 * from a comparison that never mentioned the concept.
 *
 * "redeploy" is deliberately not in the set: whether it reuses an image or
 * builds its commit again is not known at enqueue time, so the job decides at
 * step 3 of runDeploy by asking Docker whether the image still exists.
 */
const REUSES_IMAGE: ReadonlySet<DeployTrigger> = new Set([
  "rollback",
  "reconcile",
])

/**
 * A deploy job runs exactly once, like the sidecar bootstraps; the queue's
 * retry-with-backoff stays for stop, remove, route sync and prune.
 *
 * - Most deploy failures are deterministic — a bad Dockerfile, a RUN step over
 *   BuildKit's limit, an unresolvable ${VAR}, an app that never passes the
 *   health gate. A builder exit cannot be told apart from a transient one
 *   without parsing BuildKit's free text, so retrying just repeats the failure.
 * - Each attempt holds the single worker. Three runs of a failing build park
 *   every other job — stops, sidecar re-ensures, other deploys — behind it.
 * - A delayed retry is claimed by created_at once its backoff expires, so it can
 *   land AFTER a newer deploy of the same resource succeeded and put the older
 *   image back over it, repointing the resource and its rollback target.
 *
 * Recovery is the user's Deploy button or the next push. A failed redeploy
 * leaves the old container serving; the reconciler only redeploys the last
 * image that succeeded, for a resource whose container is gone, so it never
 * retries a failed build. A job recovered at startup after a crash or restart
 * still re-runs once: claim() does not check attempts.
 */
const DEPLOY_MAX_ATTEMPTS = 1

/**
 * The payload fields of a deploy that builds the branch head: not a rollback
 * or reconcile (useExistingImage), and not a "Deploy this again" (redeployOf
 * absent — null matches a missing field, see findPendingJob).
 *
 * A queued or running redeploy also has useExistingImage false, but it deploys
 * a recorded image or a pinned commit, not what the branch now holds. A push
 * folded into it, or a Deploy press sent to it, would never get the branch
 * head built; a running one that happens to be at the pushed commit still
 * says nothing about what the push asked for.
 */
const BRANCH_BUILD = { useExistingImage: false, redeployOf: null } as const

/** Queues a deploy and returns the deployment id. Handlers call this, never runDeploy. */
export function enqueueDeploy(
  resourceId: string,
  image: string,
  // A redeploy carries fields this does not write; enqueueRedeploy owns it.
  trigger: Exclude<DeployTrigger, "redeploy"> = "manual",
): string {
  const reuses = REUSES_IMAGE.has(trigger)
  const deployment = createDeployment({
    resourceId,
    image,
    trigger,
    // A deploy that builds records its commit when it fetches; one that
    // reuses an image inherits the commit that image was built from.
    ...(reuses ? commitForImage(resourceId, image) : null),
  })
  enqueue(
    "deploy",
    {
      resourceId,
      deploymentId: deployment.id,
      image,
      useExistingImage: reuses,
    } satisfies DeployPayload,
    { maxAttempts: DEPLOY_MAX_ATTEMPTS },
  )
  publishStatus({ resourceId, state: "queued" })
  return deployment.id
}

/**
 * The deploymentId a queued job's payload names, or null when the job is gone
 * or its payload is not the shape enqueueDeploy writes.
 *
 * The payload is read back from TEXT, so it is narrowed rather than trusted.
 */
function deploymentIdOfJob(jobId: string): string | null {
  const job = getJob(jobId)
  if (!job) return null
  let payload: unknown
  try {
    payload = JSON.parse(job.payload_json)
  } catch {
    return null
  }
  if (typeof payload !== "object" || payload === null) return null
  const id: unknown = Reflect.get(payload, "deploymentId")
  return typeof id === "string" ? id : null
}

/** What enqueueDeployCoalesced did with a push. */
export type CoalescedDeploy =
  | { outcome: "queued"; deploymentId: string }
  /** Folded into a build deploy of the resource that has not started (D52). */
  | { outcome: "folded" }
  /** A running deploy of the resource is already building `after`. */
  | { outcome: "running"; deploymentId: string }

/**
 * Queues a push-triggered deploy, folding it into one that has not started.
 *
 * Pushes arrive in bursts — five commits in one `git push`, a merge, a CI bot —
 * and job concurrency is exactly 1, so a job per delivery parks real work
 * behind a queue of redundant builds of nearly the same tree. A deploy that is
 * still waiting has not fetched yet, and fetches the branch's newest commit
 * when it runs, so this push is already in it: "folded".
 *
 * Otherwise only a running deploy that fetched exactly `after` — the commit
 * the push moved the branch to — makes the push redundant: "running". That is
 * a redelivery, or the same push reaching GitHub twice. A running deploy of
 * any other commit fetched an older tree, and one that has finished — or
 * failed — deployed nothing of this push; either way the push gets its own
 * deploy. The 60-second bucket this replaces treated a failed row as "already
 * queued", so a fix pushed within a minute of a broken build was dropped (T-1,
 * D52). With no `after`, the running check is skipped: behaves as before.
 *
 * Every lookup and the insert are synchronous calls on the one write
 * connection, so no other enqueue — and no claim — can land between them.
 */
export function enqueueDeployCoalesced(
  resourceId: string,
  after?: string | null,
): CoalescedDeploy {
  if (findPendingJob("deploy", { resourceId, ...BRANCH_BUILD }) !== null) {
    return { outcome: "folded" }
  }
  if (typeof after === "string") {
    // commitSha is recorded when the deploy fetches, so a running deploy that
    // has not fetched yet has none and never matches: the push is queued,
    // which is the safe side.
    for (const jobId of findLeasedJobs("deploy", {
      resourceId,
      ...BRANCH_BUILD,
    })) {
      const deploymentId = deploymentIdOfJob(jobId)
      if (deploymentId === null) continue
      const deployment = getDeployment(deploymentId)
      if (deployment?.status === "running" && deployment.commitSha === after) {
        return { outcome: "running", deploymentId }
      }
    }
  }
  // A push always builds, so the row names the placeholder, never an image.
  const image = BUILD_PLACEHOLDER
  const deployment = createDeployment({
    resourceId,
    image,
    trigger: "webhook",
  })
  enqueue(
    "deploy",
    {
      resourceId,
      deploymentId: deployment.id,
      image,
      // A push always builds. Never REUSES_IMAGE — see that set's comment.
      useExistingImage: false,
    } satisfies DeployPayload,
    { maxAttempts: DEPLOY_MAX_ATTEMPTS },
  )
  publishStatus({ resourceId, state: "queued" })
  return { outcome: "queued", deploymentId: deployment.id }
}

/**
 * The queued build deploy of `image` for this resource, or null.
 *
 * For the Deploy button: when an identical deploy still waits and nothing else
 * for this resource is queued behind it, a second press would only run the
 * same work again once the first finishes, so the handler sends the user to
 * the waiting one instead. Branch build deploys only (BRANCH_BUILD) — a queued
 * rollback or redeploy deploys a different artifact. For a git resource `image` is
 * BUILD_PLACEHOLDER, so this matches a waiting push or Deploy of the branch;
 * for an image resource, the same image ref.
 *
 * Null when any other job for the resource — a Stop, a Rollback, anything —
 * is queued after the match: folding would run this press BEFORE that job, so
 * the resource would end stopped or rolled back although Deploy was the last
 * thing asked for. A new deploy at the back of the queue keeps the order.
 */
export function pendingDeploymentFor(
  resourceId: string,
  image: string,
): string | null {
  const jobId = findPendingJob("deploy", {
    resourceId,
    ...BRANCH_BUILD,
    image,
  })
  if (jobId === null || hasPendingJobAfter(jobId, resourceId)) return null
  return deploymentIdOfJob(jobId)
}

const FINISHED: ReadonlySet<Deployment["status"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
])

/**
 * Whether a deployment can be deployed again ("Deploy this again", D61).
 *
 * Pure, so the page and the handler agree on the answer without either asking
 * Docker or GitHub. A queued or running one is still in progress. A git row
 * needs something to repeat — a full recorded commit or a built tag; whether
 * the image survives, or the repository still matches, is decided by the job,
 * which says why when it cannot. An image row needs a reference that passes
 * the same validation Settings applies, since it is pulled and becomes the
 * resource's image.
 */
export function redeployable(
  deployment: Deployment,
  resource: Resource,
): boolean {
  if (!FINISHED.has(deployment.status)) return false
  if (resource.kind === "git") {
    return (
      (deployment.commitSha !== null &&
        isFullCommitSha(deployment.commitSha)) ||
      isBuiltImageTag(deployment.image)
    )
  }
  return (
    deployment.image !== BUILD_PLACEHOLDER && isValidImageRef(deployment.image)
  )
}

/**
 * Creates a "redeploy" row repeating `source`, queues it, and returns its id.
 *
 * The row names the source's image when it has a real one — the built tag a
 * git redeploy tries first, or the reference an image redeploy pulls — and
 * inherits its commit and build record, so the page names what is being
 * repeated before the job runs. A git rebuild overwrites them when it
 * resolves the commit.
 *
 * useExistingImage is false even for a git redeploy that will reuse: the job
 * decides at step 3, because the image may be pruned while this waits.
 */
export function enqueueRedeploy(
  source: Deployment,
  resource: Resource,
): string {
  // The route checks first; this only keeps a stray caller from queueing a
  // job step 3 would have to reject.
  if (!redeployable(source, resource)) {
    throw new Error(`deployment ${source.id} cannot be deployed again`)
  }
  const git = resource.kind === "git"
  const image =
    git && !isBuiltImageTag(source.image) ? BUILD_PLACEHOLDER : source.image
  const pinnedSha =
    git && source.commitSha !== null && isFullCommitSha(source.commitSha)
      ? source.commitSha
      : undefined
  const deployment = createDeployment({
    resourceId: resource.id,
    image,
    trigger: "redeploy",
    commitSha: source.commitSha,
    commitMessage: source.commitMessage,
    commitAuthor: source.commitAuthor,
    gitRepo: source.gitRepo,
    buildFingerprint: source.buildFingerprint,
  })
  enqueue(
    "deploy",
    {
      resourceId: resource.id,
      deploymentId: deployment.id,
      image,
      useExistingImage: false,
      redeployOf: source.id,
      // Omitted rather than null: the payload is JSON, and a null here would
      // have to be told apart from "absent" by every reader.
      ...(pinnedSha === undefined ? {} : { pinnedSha }),
    } satisfies DeployPayload,
    { maxAttempts: DEPLOY_MAX_ATTEMPTS },
  )
  publishStatus({ resourceId: resource.id, state: "queued" })
  return deployment.id
}

/**
 * Removes a queued deploy before the worker claims it; false if it has
 * already been claimed (or has no pending job), in which case nothing changes.
 *
 * Synchronous from the guarded UPDATE to the last publish, with no await:
 * nothing can run between the job leaving 'pending' and its deployment row
 * saying so, so no page or SSE subscriber ever sees a cancelled job whose
 * deployment still reads queued. No Docker either — nothing was started, so
 * there is nothing to stop.
 *
 * The two writes share one transaction: if the row update threw after the job
 * was cancelled, the job could never run and the row would read queued
 * forever. Rolled back, the job is pending again and the deploy simply runs.
 * SSE and the log line come after the commit, so they never announce a cancel
 * that was rolled back.
 */
export function cancelQueuedDeploy(
  deploymentId: string,
  resourceId: string,
): boolean {
  const cancelled = db.transaction((): boolean => {
    if (!cancelPendingDeploy(deploymentId)) return false
    updateDeployment(deploymentId, {
      status: "cancelled",
      finishedAt: nowIso(),
    })
    return true
  })()
  if (!cancelled) return false

  publishDeployment({ deploymentId, resourceId, status: "cancelled" })
  const ctx = getResourceContext(resourceId)
  if (ctx) {
    // Recomputed rather than assumed: a cancelled deploy queued behind a
    // running one leaves the resource deploying, not healthy.
    publishStatus({
      resourceId,
      state: resourceState(ctx.resource, latestDeploymentStatus(resourceId)),
    })
  }
  logger.info(
    { deploymentId, resourceId },
    "deploy cancelled before it started",
  )
  return true
}

/** After a crash, a deployment can be left claiming to be running. */
export function failStuckDeployment(deploymentId: string): void {
  const d = getDeployment(deploymentId)
  if (d && d.status === "running") {
    markDeploymentFailed(deploymentId, "interrupted by a restart")
  }
}
