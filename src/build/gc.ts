/**
 * The daemon's own cache limits, for --oci-worker-gc-keepstorage.
 *
 * Three fields, "Reserved,Free,Maximum", in MB — the order buildkitd's --help
 * gives. Reserved is the floor gc never collects below, Free a free-disk target
 * and Maximum the ceiling it collects down to. The ceiling comes from the same
 * knob that bounds the Dockerfile strategy's cache, so one number governs the
 * whole build cache.
 *
 * D18 read the order as Reserved,Maximum and passed two fields, so the ceiling
 * landed in the Free slot: the daemon kept 10 GB of the disk free and had no
 * ceiling at all. On the 2GB host's 19 GB disk, with 7.8 GB free, that emptied
 * the cache down to Reserved after every build, and every Railpack redeploy ran
 * apt, mise and npm again (T-2). `buildctl debug workers -v` shows the policy
 * the daemon actually applied, and settled it (D52).
 *
 * Free is 0, meaning no free-space target: the ceiling and the prune job bound
 * the disk, and a target sized for a large disk empties the cache on a small
 * one. It is written as 0 because an empty field ("2560,,10240") is a parse
 * error that stops buildkitd from starting.
 *
 * Reserved is a quarter of the ceiling rather than equal to it: setting them
 * equal leaves gc nothing it is permitted to reclaim.
 */
export function gcKeepStorage(cacheGb: number): string {
  const maxMb = cacheGb * 1024
  const reservedMb = Math.floor(maxMb / 4)
  return `${reservedMb},0,${maxMb}`
}
