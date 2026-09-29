import { getAppPrivateKey, getGithubApp } from "../db/queries.ts"
import {
  type Auth,
  branchNotFound,
  commitNotFound,
  ghJson,
  ghPaginate,
  isFullCommitSha,
} from "./api.ts"
import { logger } from "../log.ts"
import { appJwt } from "./jwt.ts"
import {
  createRepoCache,
  REPO_CACHE_MAX_ENTRIES,
  REPO_CACHE_MAX_ITEMS,
  REPO_LIST_STALE_MAX_AGE_MS,
  REPO_LIST_TTL_MS,
} from "./repo-cache.ts"
import {
  clearTokenCache,
  invalidateToken,
  withInstallationToken,
} from "./tokens.ts"

/** Everything musdash reads from GitHub: installations, repositories, commits. */

export interface RepoRef {
  /** "owner/name". */
  fullName: string
  defaultBranch: string
  private: boolean
}

export interface InstallationRef {
  installationId: number
  accountLogin: string
}

export interface CommitMeta {
  sha: string
  message: string | null
  author: string | null
}

/**
 * A repository reference becomes a URL path segment in the tarball fetch, so it
 * is validated for the same reason an image reference is: an unvalidated value
 * that reaches a request path is an injection vector.
 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function isValidRepoRef(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.includes("..")
}

/**
 * A branch or tag also becomes a path segment. Git itself forbids most of what
 * matters here; this rejects the rest rather than trusting the form.
 */
export function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false
  if (ref.startsWith("/") || ref.includes("..")) return false
  // Control characters, whitespace, and the metacharacters git itself forbids
  // in a ref name. Written as an explicit set rather than a character class:
  // the class needs escaping through several layers and got mangled once.
  const forbidden = new Set(["~", "^", ":", "?", "*", "[", "\\", " "])
  for (const ch of ref) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
    if (forbidden.has(ch)) return false
  }
  return true
}

interface RawRepo {
  full_name: string
  default_branch: string
  private: boolean
}

function toRepoRef(raw: RawRepo): RepoRef {
  return {
    fullName: raw.full_name,
    defaultBranch: raw.default_branch,
    private: raw.private,
  }
}

/** Every installation of this App, authenticated as the App itself. */
export async function listInstallations(): Promise<InstallationRef[]> {
  const app = getGithubApp()
  const privateKey = getAppPrivateKey()
  if (!app || !privateKey) return []

  const raw = await ghPaginate<{ id: number; account: { login: string } }>(
    "/app/installations",
    { kind: "app", jwt: appJwt(app.appId, privateKey) },
    (body) => body as { id: number; account: { login: string } }[],
  )
  return raw.map((i) => ({
    installationId: i.id,
    accountLogin: i.account.login,
  }))
}

/**
 * The repositories one installation grants.
 *
 * Note the `pick`: this endpoint wraps its items in
 * `{ total_count, repositories }` rather than returning a bare array like most
 * GitHub list endpoints. Accumulating the body itself yields envelopes.
 */
export async function listInstallationRepos(
  installationId: number,
): Promise<RepoRef[]> {
  // The WHOLE pagination is retried, not the failing page: a token rejected on
  // page 3 was also the one that fetched pages 1-2, and restarting from page 1
  // is simpler than splicing a partial list.
  const raw = await withInstallationToken(installationId, (token) =>
    ghPaginate<RawRepo>(
      "/installation/repositories",
      { kind: "installation", token },
      (body) => (body as { repositories: RawRepo[] }).repositories,
    ),
  )
  return raw.map(toRepoRef)
}

/** The picker's repository lists, one per installation. See repo-cache.ts. */
const repoCache = createRepoCache<RepoRef>({
  ttlMs: REPO_LIST_TTL_MS,
  staleMaxAgeMs: REPO_LIST_STALE_MAX_AGE_MS,
  maxEntries: REPO_CACHE_MAX_ENTRIES,
  maxItems: REPO_CACHE_MAX_ITEMS,
})

/**
 * An installation's repositories, from GitHub only on a cache miss.
 *
 * For the repository picker only. Deploys never read this: they resolve the
 * commit themselves, so a list up to an hour old can at worst offer a
 * repository the grant no longer covers, and that fails visibly at deploy.
 *
 * A failed refresh with an older list still cached renders that list and logs
 * a warning, rather than blanking the picker over a transient GitHub error.
 */
export async function cachedInstallationRepos(
  installationId: number,
): Promise<readonly RepoRef[]> {
  const { items, stale } = await repoCache.get(installationId, () =>
    listInstallationRepos(installationId),
  )
  if (stale !== null) {
    logger.warn(
      {
        installationId,
        ageSeconds: Math.round(stale.ageMs / 1000),
        err:
          stale.error instanceof Error
            ? stale.error.message
            : String(stale.error),
      },
      "could not refresh repositories for an installation; showing the list cached earlier",
    )
  }
  return items
}

/**
 * Drops everything cached for one installation: its token and its repository
 * list. For lifecycle events (suspend, permissions, repository access,
 * removal), after which both were obtained under terms that no longer hold.
 *
 * Lives here rather than in tokens.ts because repos.ts already imports
 * tokens.ts; the reverse import would be a cycle.
 */
export function forgetInstallation(installationId: number): void {
  invalidateToken(installationId)
  repoCache.forget(installationId)
}

/** Drops every cached token and repository list. For any change to the App
 *  itself (registration, disconnect) and for every installation sync. */
export function clearGitHubCaches(): void {
  clearTokenCache()
  repoCache.clear()
}

interface RawCommit {
  sha: string
  commit: { message?: string; author?: { name?: string } }
}

/**
 * Resolves a ref to the commit it points at.
 *
 * The resolved SHA is then used for the tarball too, so the commit recorded on
 * the deployment is definitionally the commit that was built — resolving the
 * branch twice would leave a window for a push to land between the two calls.
 *
 * `installationId` may be null for a public repository, which needs no token.
 */
export async function getCommit(
  installationId: number | null,
  repo: string,
  ref: string,
): Promise<CommitMeta> {
  const path = `/repos/${repo}/commits/${encodeURIComponent(ref)}`
  // The 422 is restated on the commits call itself, inside the token closure,
  // not around withInstallationToken: a failure to mint the token is a
  // different problem and must never be reported as a missing branch. Any other
  // error is rethrown as the same object. A full SHA is a pinned commit (a
  // "Deploy this again"), so its 422 names a commit, not a branch.
  const lookup = (auth: Auth): Promise<RawCommit> =>
    ghJson<RawCommit>(path, auth).catch((err: unknown) => {
      throw (
        (isFullCommitSha(ref) ? commitNotFound : branchNotFound)(
          err,
          repo,
          ref,
        ) ?? err
      )
    })
  const raw =
    installationId === null
      ? await lookup({ kind: "none" })
      : await withInstallationToken(installationId, (token) =>
          lookup({ kind: "installation", token }),
        )
  return {
    sha: raw.sha,
    message: raw.commit.message ?? null,
    author: raw.commit.author?.name ?? null,
  }
}
