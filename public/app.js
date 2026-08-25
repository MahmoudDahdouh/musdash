/* musdash client behaviour. Alpine components plus one delegated DOM
   listener — no framework, no router. */

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

  /** Status pill driven by SSE, never by polling. */
  Alpine.data("statusPill", (resourceId, initial) => ({
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
     * The same test, reading the row's own data attributes.
     *
     * The template calls this rather than passing a repository name into an
     * Alpine expression: HTML escaping does not escape an apostrophe for a
     * JavaScript string literal, and repository and branch names are chosen by
     * whoever owns the repository.
     */
    matchesEl(el) {
      return this.matches(
        el.dataset.installation || "",
        el.dataset.fullName || "",
      )
    },

    /**
     * How many rows survive the filter.
     *
     * Read off the server-rendered data attributes rather than from a copy of
     * the repository list held in this component — there is no second source of
     * truth here. Applying matches() rather than inspecting computed styles
     * keeps this independent of when Alpine happens to have flushed x-show.
     */
    visibleCount() {
      const list = this.$el.querySelector(".repo-list")
      if (!list) return 0
      let n = 0
      for (const li of list.children) {
        const installationId = li.dataset.installation || ""
        const fullName = li.dataset.fullName || ""
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

  Alpine.data("deployPill", (deploymentId, initial) => ({
    status: initial,
    pill: initial,
    init() {
      const es = new EventSource(`/d/${deploymentId}/events`)
      es.addEventListener("deployment", (e) => {
        const d = JSON.parse(e.data)
        this.status = d.status
        this.pill = d.status
      })
      window.addEventListener("beforeunload", () => es.close())
    },
  }))
})

// --------------------------------------------------------- confirm dialog

/**
 * Forms marked confirmed by the user, so the second pass through the submit
 * listener lets them through. A WeakSet holds no strong reference, so a form
 * removed from the DOM stays collectable — which matters in a codebase with an
 * explicit memory budget.
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
 * All copy travels as HTML attributes and is written with textContent. Nothing
 * is ever interpolated into a JavaScript string, which is what the old
 * `onsubmit="return confirm('...')"` did — it escaped for HTML and then landed
 * in a JS literal, a mismatch that only stayed safe because resource names are
 * restricted to [a-z0-9-].
 *
 * This is plain DOM rather than an Alpine component: it needs no reactivity,
 * and living outside `alpine:init` means it still works if Alpine fails to
 * boot. If the script does not run at all the form simply submits without a
 * prompt — failing open, because a fail-closed confirm would leave a user
 * unable to log out.
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

  event.preventDefault()

  const dialog = document.getElementById("confirm-dialog")
  // With no dialog to confirm against, submitting beats a button that
  // silently does nothing.
  if (!(dialog instanceof HTMLDialogElement)) {
    confirmedForms.add(form)
    form.requestSubmit()
    return
  }

  // Show native validation rather than a confirm for a form that cannot post.
  if (!form.reportValidity()) return

  openConfirm(dialog, form)
})

function openConfirm(dialog, form) {
  const data = form.dataset
  const title = dialog.querySelector("#confirm-title")
  const body = dialog.querySelector("#confirm-body")
  const accept = dialog.querySelector("[data-confirm-accept]")
  const cancel = dialog.querySelector("[data-confirm-cancel]")
  if (!title || !body || !accept || !cancel) return

  title.textContent = data.confirmTitle || "Are you sure?"
  body.textContent = data.confirmBody || ""
  accept.textContent = data.confirmLabel || "Confirm"
  // Assigned wholesale so the button cannot accumulate both classes across
  // successive opens. A bare `data-confirm-danger` yields "", which is falsy,
  // so presence is tested against undefined rather than truthiness.
  accept.className = data.confirmDanger === undefined ? "primary" : "danger"

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
