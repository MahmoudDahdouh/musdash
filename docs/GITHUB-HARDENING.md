# GitHub hardening — private-repo deploys at Coolify's stability

This plan brings musdash's GitHub connection and private-repo deploys up to
Coolify's level of stability without taking on Coolify's weak spots. It comes
from reading Coolify at commit `abf9915` (2026-09-28) side by side with
musdash's `src/github/`, the webhook route, and the deploy job.

Each slice below goes through the normal loop (research → spec → approval →
build → verify → validate). The notes here are input for each slice's spec, not
an approved spec. Anything that departs from an existing decision needs its own
`docs/DECISIONS.md` entry, marked as such below.

---

## Where musdash already beats Coolify — keep these

| Area                  | Coolify                                                          | musdash                                                                        |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Installation tokens   | Mints a new token plus a `/zen` call on every use, 3+ per deploy | Cached in memory, one shared mint per installation (`src/github/tokens.ts:68`) |
| Token exposure        | In the `git` command line (visible to `ps`) and `.git/config`    | Only ever a Bearer header; the tarball has no `.git`                           |
| App secrets at rest   | `client_secret` and `webhook_secret` stored in plaintext         | AES-256-GCM encrypted (`src/db/queries.ts:986`)                                |
| Bad webhook signature | HTTP 200, so GitHub's delivery UI shows success                  | HTTP 401                                                                       |
| Installation deleted  | Webhook ignored, `installation_id` goes stale                    | Row deleted (with one gap: A1 below)                                           |
| Installation id trust | Checks the query parameter via `GET /app/installations/{id}`     | Only ever learns ids from signed webhooks or a JWT-authenticated sync          |
| SSH host keys         | `StrictHostKeyChecking=no`                                       | No SSH path at all                                                             |
| Startup recovery      | Marks in-progress deploys FAILED                                 | Equivalent: `recoverOrphanedLeases` (`src/queue/index.ts`)                     |

---

## Slice A — installation lifecycle

**Why first:** these are bugs a user will hit in normal use, and the slice is
small: `src/github/`, the webhook route, and one new re-link route.

### A1. The uninstall/suspend webhook leaves resources pointing at a dead installation

- **Today:** `handleInstallation` (`src/routes/github.ts:86`) calls
  `deleteInstallation` for `deleted`/`suspend` but never calls
  `clearGitLinkage`. Both the Sync path (`src/github/register.ts:123`) and
  Disconnect (`src/routes/app.ts:1058`) do. The resource keeps a dead
  `git_installation_id`, and its next deploy fails with a 404.
- **Change:** give the webhook path the same cleanup as sync.
- **Open question:** should `suspend` clear the link, or keep it so `unsuspend`
  restores access with no user action? Keeping it needs a clear "installation
  suspended" deploy error (see B3).

### A2. Wire up token invalidation

- **Today:** `invalidateToken` (`src/github/tokens.ts:94`) has no callers.
  A revoked or narrowed token stays cached for up to about 59 minutes.
- **Change:** invalidate the installation's cached token when a
  token-authenticated call gets a 401, or a 404 on the access-token endpoint.
  Whether to retry once with a fresh token is a spec decision. Never retry more
  than once.

### A3. Re-link an existing resource

- **Today:** no route updates a resource's `git_installation_id`, repo, or
  branch after creation (`src/routes/app.ts:675-714` is create-only). After a
  disconnect, reinstall, or repo transfer, the user has to delete and recreate
  the resource.
- **Change:** a settings form on the git resource to change the installation,
  repo, and branch. PHASES §26 already lists a branch selector
  (`docs/PHASES.md:1136`).
- **Open question:** does editing the repo trigger a deploy, or wait for the
  next push or manual deploy?

**Criteria (draft):** after an uninstall webhook, no resource references the
removed installation. A 401 from GitHub empties that installation's token
cache. A resource can be pointed at a new installation or branch and deploys
without being recreated.

---

## Slice B — error messages that name the actual cause

**Why:** Coolify shows raw git stderr. musdash can do better cheaply, because
every GitHub failure already goes through `describe()` (`src/github/api.ts:123`).

| Situation                      | Today                                                                                                         | Change                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1. Clock skew**             | Shows as "the App may have been deleted or its key rotated" (401)                                             | Compare the `Date` header on the response with local time. If they differ by more than ~50s, say "this server's clock is off by N seconds." This gets Coolify's check without its extra `/zen` call. |
| **B2. Branch missing**         | Generic "GitHub returned 422 for …"                                                                           | "Branch `x` not found in `owner/repo`."                                                                                                                                                              |
| **B3. Installation suspended** | Generic 403                                                                                                   | "The GitHub App installation is suspended — unsuspend it in GitHub settings."                                                                                                                        |
| **B4. Secondary rate limit**   | A 403/429 with `retry-after` but not `x-ratelimit-remaining: 0` falls through as a generic 403 (`api.ts:131`) | Treat `retry-after` as a rate limit, and say when to retry.                                                                                                                                          |
| **B5. Network timeout**        | Bare `AbortSignal` timeout message                                                                            | "GitHub did not respond within 15s (…path…)."                                                                                                                                                        |
| **B6. Token 404**              | "the installation may no longer grant access"                                                                 | Keep this. It's already better than Coolify, which says "Repository not found."                                                                                                                      |

**Constraint:** keep the response body out of the message and keep paths
masked with `sanitizePath` (D11). Every message still goes through `safe()` in
the deploy log.

**Criteria (draft):** each row above has a test in `src/github/api.test.ts`
that feeds a canned `Response` and checks the message. This extends a file that
already exists; it doesn't broaden coverage.

---

## Slice C — large and slow repositories

- **Today:** `FETCH_TIMEOUT_MS = 120_000` (`src/github/tarball.ts:18`) limits
  the whole download plus `tar` extraction. Deploy jobs get one attempt (D44).
  A large repo over a slow VPS link fails every time. Coolify's limit is 3600s.
- **Change:**
  1. Replace the fixed total with a **stall timeout**: abort if no bytes arrive
     for 60s. Add a much larger overall cap, for example 15 minutes.
  2. **Retry the tarball fetch once**, only on network errors or 5xx, never on
     a 4xx. This is a retry inside a step, not a job retry, but it departs from
     D44's spirit. **→ needs a DECISIONS entry.**
- **Criteria (draft):** a real-VPS test with a repo over 500MB passes (see the
  test matrix below). A stalled stream is killed within about 60s and says so.

---

## Slice D — deploy and rollback parity

### D1. Deploy a specific commit, and roll back to any past build

- **Today:** rollback goes only to `previousImage`, one step back
  (`src/routes/app.ts:550-561`). PHASES §26 already asks for "Deploy this
  commit" on older deployment rows (`docs/PHASES.md:1136`).
- **Change:** deploy by SHA from the deployment history. Reuse the image when
  it still exists (D51 already carries the commit over on reuse).

### D2. Skip the build when an image for that commit already exists

- Coolify tags images by commit and skips the build if the image is present
  (`should_skip_build`).
- This interacts with the **prune job**: decide how many past images per
  resource to keep, since disk is the biggest support burden. **→ needs a
  DECISIONS entry** for the retention number.

### D3. Dedup against _running_ deploys, not just pending ones

- **Today:** a push folds only into a _pending_ deploy (D52). A webhook
  redelivered while a build is running starts a second build of the same
  commit. Manual Deploy (`src/routes/app.ts:528-548`) has no dedup at all.
- **Change:** skip enqueueing when a pending **or running** deploy exists for
  the same resource and the same commit, as Coolify does. Optionally, also keep
  a small in-memory set of recent `X-GitHub-Delivery` ids. Coolify reads that
  header but never uses it.

### D4. Cancel a pending deploy

- **Today:** the status type has `"cancelled"`, but nothing sets it.
- **Change:** cancel a job that hasn't started yet. Cancelling an in-flight
  build (killing the subprocess and cleaning up) is a separate, later slice.

---

## Slice E — submodules and Git LFS

- **Today:** the tarball endpoint returns empty submodule directories and LFS
  pointer files. The build then fails later with an unrelated error. The
  `git clone` fallback promised in `docs/DECISIONS.md:108` doesn't exist.
- **Step 1 (cheap):** after extraction, detect a non-empty `.gitmodules` or
  LFS pointer files (`version https://git-lfs.github.com/spec/v1`), and fail
  with a clear message naming the feature.
- **Step 2 (the fallback DECISIONS already allows):** `git clone --depth=1`
  via `Bun.spawn`, then submodule init and `git lfs pull` as needed.
  - Pass the token as an `http.extraHeader` through `GIT_CONFIG_COUNT` /
    `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` env vars. **Never** put it in the
    URL or the command line (Coolify's token is visible in `ps` and written to
    `.git/config`).
  - Delete `.git` before the build context is used.
  - Adds `git` (and optionally `git-lfs`) as a host requirement. **→ needs a
    DECISIONS entry**, and `install.sh` must check for them.

---

## Small items

- **`[skip ci]` / `[skip cd]`:** skip a push when every commit message carries
  it, as Coolify does.
- **Repo picker cache:** every project page makes an uncached, 15s-bounded
  GitHub call per installation (`src/routes/app.ts:1108-1144`, deferred in D11).
- **Branch names with a slash:** `getCommit` sends `encodeURIComponent(ref)`
  (`src/github/repos.ts:134`), so `feature/x` goes out as `feature%2Fx`. Nobody
  has confirmed GitHub resolves it. Check on a real host before changing
  anything.
- **Docs drift:**
  - `docs/RUNNING.md:34,57-62,290` still says there is "no UI to connect GitHub".
  - `docs/DECISIONS.md:1186-1196` still calls the callback and webhook
    unverified against real GitHub, though D52 describes pushes handled on a
    real host.
  - `RUNNING.md` says "repo URL" where only `owner/name` is accepted.
- **Stale comment:** `src/routes/github.ts:121` says GitHub "retries a non-2xx
  forever". GitHub doesn't redeliver automatically.

---

## Coolify weak spots — do not copy

- Retrying on "Authentication failed" or "Host key verification failed".
  Coolify's retry patterns match git's own error text, so a bad token is
  retried 3 times.
- Turning the access-token endpoint's 404 into "Repository not found". That
  error really means "installation removed".
- Swallowing API errors so the user sees an empty repo list or an empty
  changed-files list.
- Storing deploy logs in the database, re-encoded on every output chunk.
- Deploy keys with `StrictHostKeyChecking=no`. If deploy keys are ever added,
  pin GitHub's published host keys.
- Putting the token in the clone URL or the command line.
- Webhooks that answer 200 to every failure.
- Placeholder installation ids (`1234567890`) that make an unconnected App
  report as connected.

---

## Real-VPS test matrix

Coolify earned its stability from years of user bug reports. musdash can reach
the same point faster with a repeatable real-host run. Record the results as a
`docs/VPS-TEST-*` report, the same way earlier phases did.

| #   | Scenario                                                      | Expected                                                      |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Private repo on a personal account                            | Deploys                                                       |
| 2   | Private repo in an organization                               | Deploys                                                       |
| 3   | Uninstall the App while a resource is linked                  | Resource shows as unlinked; clear message on deploy (A1)      |
| 4   | Suspend, then unsuspend the installation                      | Clear "suspended" error, then recovers (A1/B3)                |
| 5   | Regenerate the App's private key in GitHub                    | Clear message; reconnect fixes it                             |
| 6   | Server clock off by 2 minutes                                 | "Clock is off by N seconds" (B1)                              |
| 7   | Repo over 500MB on a slow link                                | Deploys; a stall is reported as a stall (C)                   |
| 8   | Branch named `feature/x`                                      | Resolves and deploys                                          |
| 9   | Force-push to the watched branch                              | Deploys the new head                                          |
| 10  | Redeliver a webhook from GitHub's UI while a build is running | No second build of the same commit (D3)                       |
| 11  | Delete the watched branch                                     | Push is ignored; the next deploy says "branch not found" (B2) |
| 12  | Repo with a submodule / with LFS files                        | Clear message (E step 1), or deploys (E step 2)               |
| 13  | Idle RSS after all of the above                               | Still ≤ 100MB                                                 |

---

## Order

**A → B → C → D → E**, then the small items. A and B fix what users hit today
and touch only the GitHub layer. C and D each need a DECISIONS entry first.
E's step 1 is cheap enough to do early if a real user has submodules.
