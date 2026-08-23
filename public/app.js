/* mosdash client behaviour. Alpine components only — no framework, no router. */

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
