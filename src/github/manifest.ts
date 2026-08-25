/**
 * The GitHub App manifest.
 *
 * Each musdash instance registers its OWN App rather than being configured
 * against a shared one: the user POSTs this descriptor to GitHub, confirms, and
 * GitHub redirects back with a code that exchanges for the credentials
 * (DECISIONS, "GitHub — App, not OAuth App"). Nothing to copy and paste, and no
 * shared App whose owner could read every install's repositories.
 *
 * Pure: no I/O, no database, no config read. The route supplies the name and
 * the public URL, which is what makes this testable and what keeps the
 * name-collision decision visible at the call site.
 */

export interface ManifestDescriptor {
  name: string
  url: string
  hook_attributes: { url: string; active: true }
  redirect_url: string
  public: false
  default_events: ["push"]
  default_permissions: { contents: "read"; metadata: "read" }
}

export class ManifestError extends Error {
  override readonly name = "ManifestError"
}

/**
 * Builds the descriptor GitHub's manifest flow expects.
 *
 * Throws when publicUrl is unset, rather than emitting a manifest with
 * "undefined" in three URLs. The App would register and then be permanently
 * broken: GitHub bakes the webhook and redirect URLs into the App at creation,
 * so the only repair is deleting it and starting over. Config is optional at
 * startup by design (a fresh install must boot to reach the setup page), which
 * makes THIS the right place for the error.
 *
 * Permissions are the minimum that works: read contents to fetch a tarball,
 * read metadata because GitHub requires it alongside anything else. No write
 * scope at all — musdash never pushes, comments, or sets a status.
 */
export function buildManifest(
  publicUrl: string | undefined,
  name: string,
): ManifestDescriptor {
  if (!publicUrl) {
    throw new ManifestError(
      "This dashboard has no domain yet. GitHub needs a public HTTPS address " +
        "to send the registration callback and webhooks to, so set a domain " +
        "under Dashboard address before connecting GitHub.",
    )
  }
  const base = publicUrl.replace(/\/$/, "")

  return {
    name,
    url: base,
    // active:true — an App whose webhook is inactive registers fine and then
    // silently never delivers, which looks exactly like a broken signature.
    hook_attributes: { url: `${base}/webhooks/github`, active: true },
    redirect_url: `${base}/settings/github/callback`,
    // A public App can be installed by anyone who finds it. This one is for a
    // single self-hosted instance.
    public: false,
    // push is the only event we can ask for. installation and
    // installation_repositories are lifecycle events GitHub delivers to every
    // App automatically and REJECTS in default_events — listing them makes
    // the whole manifest invalid, which GitHub reports as "not a valid GitHub
    // App manifest". routes/github.ts still receives both.
    default_events: ["push"],
    default_permissions: { contents: "read", metadata: "read" },
  }
}
