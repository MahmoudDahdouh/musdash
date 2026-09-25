/* musdash client behaviour. Alpine components plus a few delegated DOM
   listeners — no framework, no router. */

document.addEventListener("alpine:init", () => {
  /**
   * Live log panel.
   *
   * Auto-scroll pauses the moment the user scrolls away from the bottom and
   * stays paused until they ask to resume. Every deploy tool gets this wrong by
   * yanking you back to the bottom mid-read; getting it right is noticeable.
   */
  Alpine.data("logPanel", (url) => ({
    paused: false,
    source: null,

    init() {
      this.scrollToEnd()
      this.source = new EventSource(url)
      this.source.addEventListener("log", (e) => {
        const line = JSON.parse(e.data)
        this.append(line.text, line.stream)
      })
      this.source.addEventListener("line", (e) => {
        this.append(JSON.parse(e.data).text, "stdout")
      })
      // Release the connection when the page goes away, so the server can drop
      // its Docker log stream.
      window.addEventListener("beforeunload", () => this.source?.close())
      this.$el.addEventListener("alpine:destroyed", () => this.source?.close())
    },

    append(text, stream) {
      const box = this.$refs.box
      const el = document.createElement("span")
      if (stream === "stderr") el.className = "stderr"
      el.textContent = text
      box.appendChild(el)
      // Bound the DOM the same way the server bounds its ring buffer.
      while (box.childElementCount > 1000)
        box.removeChild(box.firstElementChild)
      if (!this.paused) this.scrollToEnd()
    },

    onScroll() {
      const box = this.$refs.box
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
      this.paused = !atBottom
    },

    resume() {
      this.paused = false
      this.scrollToEnd()
    },

    scrollToEnd() {
      this.$nextTick(() => {
        const box = this.$refs.box
        if (box) box.scrollTop = box.scrollHeight
      })
    },
  }))

  /** A resource's status, driven by SSE, never by polling. The label map
   *  lives in views/partials/status.eta; this only holds the state. */
  Alpine.data("resourceStatus", (resourceId, initial) => ({
    state: initial,
    init() {
      const es = new EventSource(`/r/${resourceId}/events`)
      es.addEventListener("status", (e) => {
        this.state = JSON.parse(e.data).state
      })
      es.addEventListener("deployment", (e) => {
        const d = JSON.parse(e.data)
        if (d.status === "succeeded" || d.status === "failed") {
          // The overview's deployment table is server-rendered, so refresh it
          // once the deploy settles rather than mirroring state client-side.
          setTimeout(() => window.location.reload(), 600)
        }
      })
      window.addEventListener("beforeunload", () => es.close())
    },
  }))

  /**
   * The git-resource dialog's repository picker.
   *
   * Every repository this instance can see is already in the DOM, rendered by
   * the route from one API call per installation. This component holds the
   * selection and filters what is rendered — it fetches nothing and mirrors no
   * server state, because SQLite and GitHub already know all of it.
   *
   * `installationId` and `repo` are bound to hidden inputs rather than being
   * form controls themselves, which is what lets the local-directory escape
   * hatch clear the installation and put a free-text path into the same `repo`
   * field the picker writes.
   */
  Alpine.data("repoPicker", () => ({
    installationId: "",
    repo: "",
    branch: "main",
    filter: "",

    /** Whether one rendered repository row survives the current filter. */
    matches(installationId, fullNameLower) {
      if (installationId !== this.installationId) return false
      const needle = this.filter.trim().toLowerCase()
      return needle === "" || fullNameLower.includes(needle)
    },

    /**
     * The same test, reading the row's own data attributes. The template calls
     * this rather than passing a repository name into an Alpine expression:
     * HTML escaping does not escape an apostrophe for JavaScript, and a
     * repository's owner chooses its name.
     */
    matchesEl(el) {
      return this.matches(
        el.dataset.installation || "",
        el.dataset.fullName || "",
      )
    },

    /**
     * How many rows survive the filter, read off the server-rendered data
     * attributes — this component holds no copy of the list. Applying
     * matches() rather than reading computed styles keeps it independent of
     * when Alpine flushes x-show.
     */
    visibleCount() {
      const list = this.$el.querySelector(".repo-list")
      if (!list) return 0
      let n = 0
      for (const row of list.children) {
        const installationId = row.dataset.installation || ""
        const fullName = row.dataset.fullName || ""
        if (this.matches(installationId, fullName)) n += 1
      }
      return n
    },

    /** A repository was chosen: adopt its default branch. */
    pick(defaultBranch) {
      if (defaultBranch) this.branch = defaultBranch
    },

    /** Switching accounts invalidates a repository chosen under the old one. */
    onInstallationChange() {
      this.repo = ""
      this.filter = ""
    },

    /**
     * The local-directory escape hatch. A path is not a GitHub repository, so
     * the installation is cleared: the server treats an absent installationId
     * as "this is a local source" and skips repository-reference validation.
     */
    useLocal(path) {
      const value = path.trim()
      if (value === "") return
      this.installationId = ""
      this.repo = value
    },
  }))

  Alpine.data("deploymentStatus", (deploymentId, initial) => ({
    state: initial,
    init() {
      const es = new EventSource(`/d/${deploymentId}/events`)
      es.addEventListener("deployment", (e) => {
        this.state = JSON.parse(e.data).status
      })
      window.addEventListener("beforeunload", () => es.close())
    },
  }))
})

// --------------------------------------------------------- confirm dialog

/**
 * Forms the user confirmed, so the second pass through the submit listener
 * lets them through. A WeakSet, so a removed form stays collectable.
 */
const confirmedForms = new WeakSet()

/**
 * Shared confirm dialog.
 *
 * One <dialog> in the layout serves every state-changing form on the page.
 * Forms opt in with `data-confirm` plus `data-confirm-*` text attributes and
 * hold no Alpine state, so a resource with eight removable domains still has
 * one dialog and one listener rather than eight components.
 *
 * All copy travels as HTML attributes and is written with textContent, never
 * interpolated into a JavaScript string: HTML escaping does not make a value
 * safe inside a JS literal.
 *
 * Plain DOM, outside `alpine:init`, so it works even if Alpine fails to boot.
 * Without the script the form submits unprompted — failing open, because a
 * fail-closed confirm would leave a user unable to log out.
 */
document.addEventListener("submit", (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (!form.hasAttribute("data-confirm")) return
  // Second pass, after the user accepted: let it through.
  if (confirmedForms.has(form)) {
    confirmedForms.delete(form)
    return
  }

  // With no complete dialog to confirm against, let this submission through:
  // a button that silently does nothing is worse than a missing prompt. The
  // check comes before preventDefault because a form cannot be re-submitted
  // from inside its own submit event — requestSubmit() there is ignored.
  const dialog = document.getElementById("confirm-dialog")
  const parts = dialog instanceof HTMLDialogElement && confirmParts(dialog)
  if (!parts) return

  event.preventDefault()

  // Show native validation rather than a confirm for a form that cannot post.
  if (!form.reportValidity()) return

  openConfirm(dialog, parts, form)
})

function confirmParts(dialog) {
  const title = dialog.querySelector("#confirm-title")
  const body = dialog.querySelector("#confirm-body")
  const accept = dialog.querySelector("[data-confirm-accept]")
  const cancel = dialog.querySelector("[data-confirm-cancel]")
  return title && body && accept && cancel
    ? { title, body, accept, cancel }
    : null
}

function openConfirm(dialog, { title, body, accept, cancel }, form) {
  const data = form.dataset

  title.textContent = data.confirmTitle || "Are you sure?"
  body.textContent = data.confirmBody || ""
  accept.textContent = data.confirmLabel || "Confirm"
  // Assigned wholesale so the button cannot accumulate both classes across
  // successive opens. A bare `data-confirm-danger` yields "", which is falsy,
  // so presence is tested against undefined rather than truthiness.
  accept.className =
    data.confirmDanger === undefined ? "btn btn-primary" : "btn btn-danger"

  const onAccept = () => {
    confirmedForms.add(form)
    dialog.close()
    // requestSubmit, not submit: submit() skips HTML5 constraint validation,
    // which would let a form with required or min/max inputs POST junk.
    form.requestSubmit()
  }
  const onCancel = () => dialog.close()
  const onClose = () => {
    accept.removeEventListener("click", onAccept)
    cancel.removeEventListener("click", onCancel)
    // Escape and an explicit close both fire `close`, so unwinding here covers
    // every exit path and the next open starts with no stale listeners.
    dialog.removeEventListener("close", onClose)
  }

  accept.addEventListener("click", onAccept)
  cancel.addEventListener("click", onCancel)
  dialog.addEventListener("close", onClose)

  dialog.showModal()
  // Focus the safe choice, never the destructive one — Enter must not be able
  // to delete something the user has not read yet. showModal() already gives
  // us Escape-to-close, a focus trap, and focus restored to the trigger.
  cancel.focus()
}

// --------------------------------------------------------- backdrop close

/**
 * Close any modal <dialog> when the user clicks its backdrop.
 *
 * A backdrop click lands on the <dialog> element itself, but so does a click
 * in the dialog's own padding, so the target alone cannot tell them apart —
 * the pointer is compared against the dialog's box instead.
 *
 * The press must also start outside. Dragging a text selection out of an
 * input and releasing over the backdrop fires `click` on the dialog, and
 * losing a half-typed form to a sloppy selection would be worse than having
 * no backdrop close at all.
 *
 * close() fires `close`, so the confirm dialog's own unwinding runs exactly as
 * it does for Cancel or Escape, and its form is not submitted.
 */
let pressedOutside = false

function isOutside(dialog, event) {
  const box = dialog.getBoundingClientRect()
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
}

document.addEventListener("pointerdown", (event) => {
  const target = event.target
  pressedOutside =
    target instanceof HTMLDialogElement && isOutside(target, event)
})

document.addEventListener("click", (event) => {
  const target = event.target
  if (
    target instanceof HTMLDialogElement &&
    target.open &&
    pressedOutside &&
    isOutside(target, event)
  ) {
    target.close()
  }
  pressedOutside = false
})

// ---------------------------------------------------------- pending state

/**
 * A submitted form's button turns busy and disabled, so a double click cannot
 * post twice. Deferred a tick so the confirm listener has already decided,
 * whatever the listener order; the form data is built by then, so disabling
 * the button changes nothing posted. Feedback only: no timer re-enables it.
 */
document.addEventListener("submit", (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  // A confirmed form resubmits through requestSubmit() with no submitter.
  const button =
    event.submitter ??
    form.querySelector('button[type="submit"], button:not([type])')
  setTimeout(() => {
    if (event.defaultPrevented || form.method === "dialog") return
    if (!(button instanceof HTMLButtonElement)) return
    button.setAttribute("aria-busy", "true")
    button.disabled = true
  })
})

// The back/forward cache restores a page as it was left, busy buttons too.
window.addEventListener("pageshow", () => {
  for (const button of document.querySelectorAll('[aria-busy="true"]')) {
    button.removeAttribute("aria-busy")
    button.disabled = false
  }
})

// --------------------------------------------------------- dialog openers

// `commandfor`/`command` open and close dialogs with no script. This is the
// fallback where Invoker Commands are missing, and it stands aside where they
// exist so a dialog is never told to open twice.
document.addEventListener("click", (event) => {
  if ("command" in HTMLButtonElement.prototype) return
  const target = event.target
  if (!(target instanceof Element)) return
  const opener = target.closest("[data-open]")
  if (opener instanceof HTMLElement) {
    const dialog = document.getElementById(opener.dataset.open || "")
    if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal()
    return
  }
  if (target.closest("[data-close]")) target.closest("dialog")?.close()
})

// -------------------------------------------------------------- row links

// A row whose first cell links somewhere navigates from anywhere in it; the
// link stays the real target. Controls and `.copy` cells are left alone: the
// first click of a double-click would navigate before a SHA is selected.
document.addEventListener("click", (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (
    target.closest("a, button, input, select, textarea, label, summary, .copy")
  )
    return
  const row = target.closest(".table tbody tr")
  const link = row?.querySelector(":scope > td:first-child a[href]")
  if (!(link instanceof HTMLAnchorElement)) return
  if (!window.getSelection()?.isCollapsed) return
  if (event.ctrlKey || event.metaKey)
    window.open(link.href, "_blank", "noopener")
  else if (!event.shiftKey && !event.altKey) location.assign(link.href)
})
