/* Compose forms. Page-scoped — linked only by pages that render Compose
   content (render.ts decides). Plain DOM, no Alpine and no state: everything
   here reads the server-rendered form. */

// A refused paste comes back with its dialog rendered `open`, which shows it
// non-modal even without script. Reopened as a modal like every other dialog,
// so Escape, the focus trap and the backdrop behave the same.
for (const dialog of document.querySelectorAll("dialog[data-reopen]")) {
  if (!(dialog instanceof HTMLDialogElement)) continue
  dialog.close()
  dialog.showModal()
}

/**
 * Once a public service is named its port is required. The server refuses the
 * same form (compose-port-required); this only says so before the round trip,
 * where the pasted file would otherwise be lost.
 */
function syncPortRequired(form) {
  const service = form.elements.namedItem("publicService")
  const port = form.elements.namedItem("publicPort")
  if (service instanceof HTMLInputElement && port instanceof HTMLInputElement) {
    port.required = service.value.trim() !== ""
  }
}

for (const form of document.querySelectorAll("form[data-compose-form]")) {
  syncPortRequired(form)
}

/**
 * A service has one port for all its domains (D66), so choosing a service in
 * a Domains form fills in the port it already answers on, carried by the
 * option's data-port. A service with none leaves the field as it was. The
 * server refuses a different port (domain-port-conflict); this only saves the
 * round trip. form.elements, not a DOM sibling: a table row's controls belong
 * to their form through the form attribute.
 */
document.addEventListener("change", (event) => {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  if (target.name !== "serviceName") return
  const port = target.form?.elements.namedItem("containerPort")
  const value = target.selectedOptions[0]?.dataset.port
  if (port instanceof HTMLInputElement && value) port.value = value
})

document.addEventListener("input", (event) => {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  if (target.name !== "publicService") return
  const form = target.form
  if (form?.hasAttribute("data-compose-form")) syncPortRequired(form)
})

// ---------------------------------------------------------- volume sizes

/**
 * Bytes in binary units, as `df -h` and Docker's own CLI count them. The
 * units are symbols, not words, so they live here rather than in a template.
 */
function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const digits = i === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[i]}`
}

/** A size the server reported, or null for anything else. */
function sizeOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

/**
 * Writes each size into its cell, or the element's "unknown" word when there
 * is none. textContent only: a volume name is attacker-influenced, and
 * nothing the server sends is ever parsed as HTML. The word comes from the
 * element's data-unknown, else its container's — never from here.
 */
function fillSizes(container, data) {
  const fallback = container.dataset.unknown ?? ""
  const known = data !== null && data.known === true
  const volumes =
    known && typeof data.volumes === "object" && data.volumes !== null
      ? data.volumes
      : {}
  for (const el of container.querySelectorAll("[data-volume-size]")) {
    if (!(el instanceof HTMLElement)) continue
    const name = el.dataset.volumeSize ?? ""
    // hasOwn, so a volume named like an Object.prototype key reads as absent.
    const size = Object.hasOwn(volumes, name) ? sizeOf(volumes[name]) : null
    el.textContent =
      size === null ? (el.dataset.unknown ?? fallback) : formatBytes(size)
  }
  for (const el of container.querySelectorAll("[data-volume-total]")) {
    if (!(el instanceof HTMLElement)) continue
    const total = known ? sizeOf(data.totalBytes) : null
    el.textContent =
      total === null ? (el.dataset.unknown ?? fallback) : formatBytes(total)
  }
}

/**
 * One request per endpoint, shared by every container that names it. A
 * failure, a non-JSON body, or a redirect — a signed-out session is sent to
 * /login, which fetch follows silently — all read as "unknown".
 */
async function loadSizes(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } })
    if (!res.ok || res.redirected) return null
    const data = await res.json()
    return typeof data === "object" && data !== null ? data : null
  } catch {
    return null
  }
}

const sizeRequests = new Map()
for (const container of document.querySelectorAll("[data-volume-sizes]")) {
  if (!(container instanceof HTMLElement)) continue
  const url = container.dataset.volumeSizes ?? ""
  // Same-origin paths only: the attribute is server-rendered, but a fetch
  // must never be pointed elsewhere by anything that reaches it.
  if (!url.startsWith("/") || url.startsWith("//")) continue
  if (!sizeRequests.has(url)) sizeRequests.set(url, loadSizes(url))
  sizeRequests.get(url).then((data) => fillSizes(container, data))
}

// ------------------------------------------- delete card: volumes checkbox

/**
 * The delete form's confirm text follows the "Also delete these volumes"
 * box: both texts are on the form as data-*, and app.js's dialog reads
 * data-confirm-body when it opens. The keep text is the server-rendered
 * default, so without this script the prompt is the safe one.
 */
function syncDeleteConfirm(box) {
  const form = box.form
  if (!form) return
  const text = box.checked
    ? form.dataset.confirmBodyDelete
    : form.dataset.confirmBodyKeep
  if (text !== undefined) form.dataset.confirmBody = text
}

function syncAllDeleteConfirms() {
  for (const box of document.querySelectorAll(
    'input[type="checkbox"][name="deleteVolumes"]',
  )) {
    if (box instanceof HTMLInputElement) syncDeleteConfirm(box)
  }
}

// A browser restores a ticked box on reload or back-navigation, sometimes
// after this script has run. Synced now, again once the page has loaded and
// on a return from the back-forward cache, and — the guarantee — in the
// capture phase of every submit, which runs before app.js's confirm listener
// on the bubble phase, so the dialog never shows a stale text.
syncAllDeleteConfirms()
window.addEventListener("load", syncAllDeleteConfirms)
window.addEventListener("pageshow", syncAllDeleteConfirms)
document.addEventListener("submit", syncAllDeleteConfirms, true)
document.addEventListener("change", (event) => {
  const target = event.target
  if (target instanceof HTMLInputElement && target.name === "deleteVolumes") {
    syncDeleteConfirm(target)
  }
})
