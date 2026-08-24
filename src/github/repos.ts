import { getAppPrivateKey, getGithubApp } from "../db/queries.ts"
import { ghJson, ghPaginate } from "./api.ts"
import { appJwt } from "./jwt.ts"
import { installationToken } from "./tokens.ts"

/** Everything mosdash reads from GitHub: installations, repositories, commits. */

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
  const token = await installationToken(installationId)
  const raw = await ghPaginate<RawRepo>(
    "/installation/repositories",
    { kind: "installation", token },
    (body) => (body as { repositories: RawRepo[] }).repositories,
  )
  return raw.map(toRepoRef)
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
  const auth =
    installationId === null
      ? ({ kind: "none" } as const)
      : ({
          kind: "installation" as const,
          token: await installationToken(installationId),
        } as const)

  const raw = await ghJson<RawCommit>(
    `/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    auth,
  )
  return {
    sha: raw.sha,
    message: raw.commit.message ?? null,
    author: raw.commit.author?.name ?? null,
  }
}
