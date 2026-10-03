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
