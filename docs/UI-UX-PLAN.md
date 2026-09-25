# musdash UI/UX plan

A full review of the dashboard as it stands at commit `753513c`, and the plan to
bring it to the level of a modern web app without adding a byte of runtime the
product cannot afford. Written for whoever runs the next UI slices: the human
approving each brief, and the UI-Builder executing it.

The review was done against the live app (booted on a scratch data directory,
walked with a real browser at 1280px and 390px, in light and dark mode), the
templates in `src/views/`, and `public/app.css` / `public/app.js`. Sources for
the external guidance are listed at the end.

## Contents

1. [Verdict](#1-verdict)
2. [Constraints that shape every choice](#2-constraints-that-shape-every-choice)
3. [What is already right, and stays](#3-what-is-already-right-and-stays)
4. [Findings](#4-findings)
5. [Design direction](#5-design-direction)
6. [Design system specification](#6-design-system-specification)
7. [Page-by-page plan](#7-page-by-page-plan)
8. [Slices, in order](#8-slices-in-order)
9. [Verification](#9-verification)
10. [Sources](#10-sources)

---

## 1. Verdict

The foundation is sound and unusually disciplined for a scaffold: custom
properties, `prefers-color-scheme`, a native `<dialog>` with a CSS-only enter
and exit, an inline SVG sprite instead of an icon library, a shared confirm
dialog that fails open, and log auto-scroll that pauses on read. The copy is
better than most shipped products. None of that should be thrown away.

What holds it back is not a missing framework. It is three things:

- **A handful of real defects** that a user would hit in the first ten minutes:
  native form validation is silently switched off by invalid `pattern`
  regexes, the resource page scrolls sideways on a phone, and a disabled button
  is indistinguishable from an enabled one.
- **No system underneath the styles.** Spacing, radii, type sizes and colours
  are ad hoc literals; the two token blocks (light and dark) are maintained by
  hand; the same table is styled twice; `h3` is globally an uppercase eyebrow
  so every card looks like a form section and resource names render in
  capitals.
- **A visual language that reads as a default.** Tailwind-blue-600 buttons,
  saturated filled status pills, red boxes used for guidance as well as
  errors, and nothing that says what this product is.

The plan fixes the defects first (one short slice), then rebuilds the token
layer and components once, then walks the pages. Total footprint after the
work: **no new dependencies, no web fonts, no images, no new requests**, and a
CI gate so `app.css` and `app.js` cannot quietly grow. Idle RSS is untouched:
assets are strings embedded in the binary either way.

Measured today: `app.css` 17.9 KB, `app.js` 11.6 KB, `alpine.js` 75.5 KB
(vendored, unchanged), 105 KB total.

---

## 2. Constraints that shape every choice

These come from `CLAUDE.md` and `docs/PHASES.md` §11 and are not up for
re-litigation here.

| Constraint                                        | What it rules out in this plan                           |
| ------------------------------------------------- | -------------------------------------------------------- |
| No build step, no Tailwind/PostCSS/Sass           | Utility frameworks, preprocessors, any transpiled CSS    |
| No CDN; must work on a firewalled box             | Google Fonts, hosted icon sets, any `<link>` off-host    |
| The UI is a view of server state                  | A client-side store, client-side routing, optimistic UI  |
| SSE, not polling; Alpine for behaviour            | Socket.io, fetch-and-render loops, a second JS framework |
| Idle RSS ≤ 100 MB with a CI gate                  | Anything retained per request or per open page           |
| Assets embedded via static imports in `render.ts` | Runtime file reads, dynamic imports, multiple CSS files  |

Two constraints are **added by this plan**, so the "lightweight" promise is a
gate rather than a hope:

- **Asset byte budget:** `public/app.css` ≤ 32 KB and `public/app.js` ≤ 16 KB,
  unminified, checked by `bun run ci`. The numbers are generous for what is
  planned and tight enough to stop drift.
- **Zero web fonts and zero raster images.** The type stack stays `system-ui`
  and `ui-monospace`. Identity comes from how the type is set, not from a
  download.

---

## 3. What is already right, and stays

- The grid shell: sidebar as a grid column, `minmax(0, 1fr)` content track,
  sticky sidebar, mobile drawer with scrim and Escape-to-close.
- Native `<dialog>` everywhere, `@starting-style` transitions, backdrop click
  that ignores drags, focus landing on the safe choice, `requestSubmit()` so
  constraint validation still runs.
- One delegated confirm listener for every destructive form, copy carried in
  `data-*` attributes and written with `textContent`.
- The SVG `<symbol>` sprite with `currentColor` strokes.
- `prefers-reduced-motion` honoured on every transition that exists.
- SSE-driven status; `location.reload()` once a deploy settles rather than a
  mirrored table.
- The 1000-line DOM cap on the log panel, matching the server ring buffer.
- The writing. Empty states explain the model; confirmations say what will
  happen; hints say why a field exists.

---

## 4. Findings

Severity follows the repo's validator contract: **Critical** breaks something a
user relies on; **Important** is a UX or accessibility gap that a modern app
would not ship; **Minor** is polish or hygiene.

### Critical

1. **Native validation is off for every name field.** Chrome compiles the
   `pattern` attribute with the `v` flag, under which an unescaped `-` inside
   a character class is a syntax error. The browser logs
   `Pattern attribute value [a-z0-9-]{1,32} is not a valid regular expression`
   and ignores the attribute, so a name like `My App` reaches the server
   unvalidated. Affects `pattern="[A-Za-z0-9 _-]{1,60}"` in
   `src/views/pages/projects.eta` and every `pattern="[a-z0-9-]{1,32}"` in
   `src/views/pages/project.eta` (new resource, new git resource, new
   environment). Fix: `[a-z0-9\-]{1,32}` and `[A-Za-z0-9 _\-]{1,60}`. Observed
   in the browser console during the review.
2. **The resource overview scrolls the whole page sideways on a phone.** The
   deployments table sits directly inside its card with no scroll wrapper, and
   at 390px the document renders 561px wide. `table.env-table` already uses
   `.table-scroll`; `table.deployments` in `src/views/pages/resource.eta` does
   not. Observed at 390px.
3. **Disabled buttons look enabled.** `public/app.css` has no `:disabled`
   rule. On Settings, "Restart musdash" carried the `disabled` attribute (a job
   was running) and "Connect GitHub" was disabled (no public URL), and both
   rendered as full-strength primary buttons. Observed at 1280px.

### Important

4. **No keyboard focus system.** There is no `:focus-visible` rule anywhere, so
   focus is whatever the engine draws: fine on inputs, faint or absent on
   `a.card`, `.nav-*` links, `.tabs a` and `button.link`. WCAG 2.2 keeps
   Focus Visible at AA and asks for an indicator with 3:1 contrast against its
   surroundings.
5. **Filled status pills fail text contrast.** White on `--ok` `#16a34a` is
   about 3.3:1 and white on `--warn` `#d97706` about 3.2:1, both below 4.5:1
   at 12px. The pills are also the most saturated objects on every page, which
   makes a healthy resource shout as loudly as a failed one.
6. **Layout breaks at phone width on the project page.** `.env-head` has no
   `flex-wrap`, so the environment name collides with its two buttons
   (observed: "production" clipped against "From repository" at 390px).
   Buttons in `.page-head .row.gap` have the same problem once a resource has
   Deploy, Rollback and Stop.
7. **The deployment page title renders at 13px.** `<h1 class="mono">` inherits
   `.mono { font-size: 13px }`, so the page's heading is smaller than its body
   text. Observed.
8. **Resource names render in capitals.** `h3` is globally
   `text-transform: uppercase` because it doubles as the card eyebrow, so the
   resource card in `project.eta` shows `WEB` for a resource named `web`. Names
   are DNS labels; case is information. The eyebrow needs its own class.
9. **Error styling is used for guidance.** Settings shows three red
   `flash-error` boxes, two of which are instructions ("This dashboard has no
   domain yet", "Not right now: a job is running"). Modern apps separate
   _info_, _warning_ and _error_ tones; a page that is all red teaches the
   user to ignore red.
10. **Form hints and "optional" markers are structurally inside the label.**
    `<label>Password <input> <small>At least 12 characters.</small></label>`
    gives the field the accessible name "Password At least 12 characters." and
    puts "optional" on its own line under the label (observed on the Add
    resource dialog). The standard pattern is `<label for>` plus
    `aria-describedby` pointing at a hint element.
11. **No pending state after submit.** Nothing changes between clicking Save or
    Deploy and the redirect landing; a double click submits twice. The UX
    guideline database rates missing submit feedback as high severity.
12. **The empty log panel is a 460px black box with nothing in it.** No
    message, no reason. Same for the container-log tab of a never-started
    resource.
13. **Native controls do not follow dark mode.** There is no
    `color-scheme: light dark` on `:root`, so scrollbars, `<select>` popups,
    number spinners and the dialog backdrop stay light in dark mode.
14. **Prose lines run to 130 characters.** Settings cards stretch to the full
    1100px content width with 15px text; comfortable reading is 60–75
    characters.
15. **Tabs are labelled from route slugs.** `resources`/`env`/`overview`
    capitalised by CSS. "Env" is an abbreviation the rest of the UI spells
    out.
16. **Inconsistent breadcrumbs.** The deployment page shows
    `Projects / web / deployment`, skipping the project and environment the
    resource page shows. The route already has both in `ctx`.

### Minor

17. Two identical table rule sets (`table.deployments`, `table.env-table`).
18. Two hand-maintained token blocks for light and dark; `light-dark()` is
    Baseline and collapses them into one.
19. `.iconbtn:hover { border-color: transparent }` is a leftover with no
    effect.
20. Inline `onclick="document.getElementById(…).showModal()"` on eight buttons.
    Works, but it is the one place JavaScript lives in markup, and it blocks a
    future Content-Security-Policy header.
21. The favicon is a text "▲" in a data URI; there is no mark anywhere else.
22. No skip link; `<main>` has no `id`; the tab `<nav>` has no `aria-label`.
23. `.pill` is `text-transform: lowercase` while every other label is sentence
    case.
24. Flash rendering is split: the layout renders `it.flash` for most pages while
    Settings renders its own from the view model. One path is enough.
25. Card titles, section titles and eyebrows share one `h3` style; there is no
    type scale to reach for.
26. Log panel height is a fixed 460px on both the resource tab and the
    deployment page, where it is the whole point of the page.
27. `.repo-option` rows and `button.small` are 27–30px tall, above the WCAG
    2.2 AA minimum of 24px but under a comfortable touch target on a phone.

---

## 5. Design direction

### The subject

A frugal control plane. The product's one-line promise is _your $5 VPS runs
your apps, not your dashboard_. The world it lives in is containers, DNS
labels, image references, commit SHAs, a SQLite file, and a memory budget that
is a product requirement. The user is one person operating their own box.

### The thesis: colour means state

On an operations dashboard the most useful thing colour can do is tell you what
is running, what is deploying and what is broken. So chromatic colour is
**reserved for status and for the one primary action**. The chrome (sidebar,
cards, tables, borders, text) is a cool neutral scale. Links are the text
colour underlined, not blue. The primary button is ink: near-black on light,
near-white on dark. When something on the page is green, amber, red or blue,
it is a container telling you something.

This is a deliberate move away from the current accent, `#2563eb`, which is
both the most common accent on the web and the same hue the UI uses for
"deploying". An accent that is also a status colour cannot mean either thing
cleanly.

### What was rejected, and why

- **A cream page with a serif display and a terracotta accent**, or **a
  near-black page with an acid-green accent**: the two looks that generated
  design converges on regardless of subject. Neither says "operations", and
  green-on-black steals the healthy colour for decoration.
- **Bundling Inter or JetBrains Mono.** Every font file is bytes on every page
  load, a request the firewall rule has to allow, and a dependency to update.
  `system-ui` renders as SF, Segoe or Roboto; `ui-monospace` renders as SF
  Mono, Cascadia or Menlo. All of them are excellent, and they cost nothing.
- **Glass, gradients, glow.** Cost in paint time and in `backdrop-filter`
  compositing, and they carry no information.

### Typography

Two roles, both from the system.

- **UI face** `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` at
  14px/1.5 body. Headings are tight (`letter-spacing: -0.02em`) and semibold
  (600), never bold; sizes come from the scale below. `text-wrap: balance` on
  headings, `text-wrap: pretty` on paragraphs.
- **Identifier face** `ui-monospace, SFMono-Regular, Menlo, Consolas,
monospace` for everything the machine reads: image references, domains,
  commit SHAs, env keys, ports, paths. **Names of things the user typed
  (projects, environments, resources) stay in the UI face**, so a page reads as
  prose with data in it rather than a terminal. Tabular figures
  (`font-variant-numeric: tabular-nums`) in every table and the RSS readout.

### The signature

The sidebar footer shows the dashboard's own weight, live from the process:

```
admin@example.com                 Log out
────────────────────────────────────────
dashboard  58 MB
```

It is the product thesis as an instrument, costs one `process.memoryUsage.rss()`
call per render (no Docker, no job), and no other PaaS can show it. It must be
labelled precisely as the dashboard process, never as "musdash total": the
Caddy and BuildKit sidecars are reported separately on the Settings page once
that data exists (Phase 4, container resource usage). The number is set in
tabular mono and updates on page load only; a live ticker would be a second
SSE consumer for no decision anyone makes.

### Status language

One component replaces `.pill`: a **dot plus a sentence-case label**.

```
● Healthy   ● Deploying   ● Unhealthy   ● Failed   ○ Stopped   ○ Queued
```

The dot carries the hue; the label carries the meaning, so nothing is conveyed
by colour alone. The dot pulses (CSS keyframe, 1.6s, disabled under
`prefers-reduced-motion`) for the two in-motion states, deploying and queued.
Filled pills survive only for the env-scope markers (`runtime`, `build`,
`both`) and are re-toned as tinted chips with dark text.

### Motion

Three durations and one easing, as tokens. Hover 120ms, dialog and drawer
180ms, page transitions 200ms via cross-document `@view-transition`, which
gives tab and page changes a native fade for three lines of CSS and no JS.
All motion is inside `@media (prefers-reduced-motion: no-preference)`.

### Copy

Already good; the rules it follows are made explicit so new slices match.
Sentence case everywhere except names, which render exactly as stored
(resource and environment names are lowercase by validation; a project name
keeps the case it was typed in). Buttons name the outcome ("Save variables", not
"Submit"). The name of an action does not change between the button, the
confirm dialog and the flash. Empty states say what the thing is and what to
do next. Errors say what happened and what to do; they do not apologise.

---

## 6. Design system specification

### 6.1 Tokens

Two layers only. **Primitives** are the raw scales; **semantic** tokens are what
components use. Components never reference a primitive directly and never
contain a literal colour, size or duration.

All colour is OKLCH, so the light and dark values of one token differ in
lightness rather than being two unrelated hex values, and `light-dark()`
holds both in one declaration. The values below are a starting point; the
builder verifies every text/background pair at 4.5:1 (3:1 for large text and
UI borders) before the slice is done.

```css
:root {
  color-scheme: light dark;

  /* Neutral scale — hue 250, very low chroma, cool. */
  --bg: light-dark(oklch(97.5% 0.003 250), oklch(15% 0.008 250));
  --surface: light-dark(oklch(100% 0 0), oklch(19% 0.008 250));
  --surface-2: light-dark(oklch(96% 0.004 250), oklch(23% 0.008 250));
  --border: light-dark(oklch(90% 0.006 250), oklch(28% 0.01 250));
  --border-2: light-dark(oklch(82% 0.008 250), oklch(36% 0.01 250));
  /* Form control outlines need 3:1 against their surroundings. */
  --border-control: light-dark(oklch(62% 0.01 250), oklch(55% 0.01 250));
  --text: light-dark(oklch(20% 0.01 250), oklch(93% 0.005 250));
  --text-2: light-dark(oklch(48% 0.015 250), oklch(72% 0.01 250));

  /* Ink: the primary action. */
  --ink: light-dark(oklch(22% 0.02 250), oklch(95% 0 0));
  --on-ink: light-dark(oklch(98% 0 0), oklch(15% 0.008 250));

  /* Status — the only chromatic colour in the chrome. */
  --ok: light-dark(oklch(55% 0.16 150), oklch(72% 0.17 150));
  --warn: light-dark(oklch(62% 0.16 75), oklch(78% 0.16 80));
  --danger: light-dark(oklch(52% 0.2 25), oklch(68% 0.19 25));
  --busy: light-dark(oklch(52% 0.18 255), oklch(72% 0.15 255));
  --idle: var(--text-2);
  /* White on the lighter dark-mode red is under 3:1: dark text there. */
  --on-danger: light-dark(oklch(100% 0 0), oklch(15% 0.008 250));

  /* Focus ring, distinct from every status hue. */
  --ring: light-dark(oklch(55% 0.2 290), oklch(75% 0.16 290));

  /* Fixed in both themes. */
  --scrim: oklch(0% 0 0 / 0.45);
  --term-bg: oklch(16% 0.006 265);
  --term-fg: oklch(89% 0.008 255);
  --term-err: oklch(82% 0.1 20);

  /* Space: 4px base. */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 20px;
  --s-6: 24px;
  --s-7: 32px;
  --s-8: 48px;

  /* Type. */
  --t-xs: 12px;
  --t-sm: 13px;
  --t-md: 14px;
  --t-lg: 16px;
  --t-xl: 20px;
  --t-2xl: 24px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  /* Shape and depth. Dark mode gets no shadows: depth comes from surface steps. */
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 14px;
  --r-full: 999px;
  --shadow-1: 0 1px 2px light-dark(oklch(0% 0 0 / 0.06), transparent);
  --shadow-2: 0 2px 8px -2px light-dark(oklch(0% 0 0 / 0.12), transparent);
  --shadow-3: 0 12px 32px -8px light-dark(oklch(0% 0 0 / 0.25), transparent);

  /* Motion. */
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --d-fast: 120ms;
  --d-base: 180ms;
  --d-page: 200ms;

  --sidebar-w: 240px;
  --content-w: 1120px;
  --prose-w: 68ch;
}
```

Tinted backgrounds for chips and notices are derived, never stored:
`color-mix(in oklab, var(--ok) 14%, var(--surface))`. That keeps every tone
correct in both modes from one source value. Mix in `oklab`, not `oklch`:
oklch interpolates hue, so a green tint on the hue-250 dark surface comes out
blue. `light-dark()` accepts only colours, which is why the shadows wrap the
colour and not the whole shadow.

A future theme toggle is `:root[data-theme="dark"] { color-scheme: dark }`
and its light twin: two rules, because `light-dark()` follows `color-scheme`.

### 6.2 Base

- `html`: `color-scheme` (above), `-webkit-text-size-adjust: 100%`.
- `body`: `--bg`, `--text`, `var(--font)`, `var(--t-md)/1.5`,
  `text-rendering: optimizeLegibility`.
- Headings: `h1` 24/1.2 600 tight; `h2` 16/1.3 600; `h3` 14/1.4 600. **No
  transform, no colour override.** `.eyebrow` is the 12px uppercase muted
  label, applied explicitly where a card wants one.
- `a`: text colour, underline with `text-underline-offset: 2px`, hover
  `--text-2`. `.link-quiet` for breadcrumbs (no underline until hover).
- `:focus-visible` on everything interactive:
  `outline: 2px solid var(--ring); outline-offset: 2px`. Inputs use
  `outline-offset: 0` and swap the border to `--ring`.
- `.skip`: visually hidden until focused, jumps to `#main`.
- `::selection` tinted from `--busy` at 25%.
- `@view-transition { navigation: auto }` inside the no-preference media query.
- `@media (pointer: coarse)` raises `.btn`, `.tabs a`, `.nav-*` and
  `.repo-option` to a 44px minimum height.

### 6.3 Components

Each component is one class family, styled once, with variants as modifiers.
Where the current class is renamed, the old name is removed in the same slice
so there is no fallback path.

| Component   | Class                                                                  | Spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button      | `.btn` + `.btn-primary` `.btn-danger` `.btn-quiet` `.btn-sm`           | 32px tall (28 for `-sm`), `--r-sm`, 500 weight. Default: `--surface`, `--border`, hover `--border-2` + `--surface-2`. Primary: `--ink`/`--on-ink`, hover mixes the ink 85% toward `--surface` (a lightness lift barely moves near-white ink in dark mode). Danger: filled `--danger`, `--on-danger` text, kept filled so the destructive choice never looks weaker than Cancel. Quiet: no border, hover `--surface-2`. `:disabled` and `[aria-busy]`: opacity 0.5, `cursor: not-allowed`, hover suppressed. `[aria-busy]` shows a 12px CSS spinner in the icon slot. `<a class="btn">` is identical and has no underline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Icon button | `.btn.btn-icon`                                                        | Square 32px, `aria-label` required. Replaces `.iconbtn`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Field       | `.field` `.label` `.hint` `.error` `.opt`                              | `<div class="field"><label class="label" for=x>Name <span class="opt">optional</span></label><input id=x aria-describedby="x-hint"><p class="hint" id="x-hint">…</p></div>`. Inputs 36px tall, `--surface` background (not `--bg`), `--border-control` (3:1; `--border` is decorative), focus per 6.2. `:user-invalid` swaps the border to `--danger` and reveals `.error` if present, so the browser's own validation gets inline styling with no JS. Textareas mono. `.checkline` stays for checkbox rows. The `.error` line sits after the hint, carries no id, and is left out of `aria-describedby` — it is visual only; the browser's own validation message is what assistive tech announces. A radio picker is a `div` with `role="radiogroup"` named by the `.label`'s id (a list role would be replaced, and a listbox needs options, not radios); its radios share a `name` so arrow keys move within it and it is one Tab stop.                                                                                                                                                        |
| Card        | `.card` + `.card-title` `.card-body` `.card-foot`                      | `--surface`, `--border`, `--r-md`, `--shadow-1`, padding `--s-5`. `a.card` hover: `--border-2` and `--shadow-2`; focus ring per 6.2; no transform. `.card-danger` tints the border from `--danger` at 40%. Stacked cards in `main` are spaced `--s-4`. `.card-body`/`.card-foot` land with the first page that needs them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Status      | `.status` + `.status-<state>`                                          | Inline-flex, 8px dot (`::before`), sentence-case label from the template. Dot colour by state: healthy/succeeded `--ok`, unhealthy `--warn`, failed `--danger`, deploying/running `--busy`, queued/stopped `--idle` hollow. `.status-deploying` and `.status-queued` pulse. The label map lives in one Eta partial, `views/partials/status.eta`, included as `@status`; the JSON state stays as it is. A live status swaps its class with `x-effect` + `className`, because a string `:class` binding never removes a class the server rendered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Chip        | `.chip` + `.chip-<tone>`                                               | Tinted background via `color-mix`, dark text of the same hue, 12px, `--r-full`. Used for env scope (`runtime`/`build`/`both`), the `private` repo marker, origin (`.chip-outline`), and — neutral, on `code` so it is mono — env key names in a `ul.chips[role=list]` (the role because WebKit drops list semantics from an unstyled list).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Notice      | `.notice` + `.notice-info` `.notice-ok` `.notice-warn` `.notice-error` | Replaces `.flash`. Left icon from the sprite (`i-info`, `i-check`, `i-alert`, `i-x-circle`, four new symbols), tinted background, border from the tone at 40%, text `--text` (not the tone colour, which fails contrast on a tint). `role="status"` for info/ok, `role="alert"` for warn/error. The layout renders the flash; inline notices (form errors, and Settings until slice 6) stay in their pages. Info is neutral (`--idle`), because blue already means deploying.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Table       | `.table` inside `.table-scroll`                                        | One rule set. 13px, header `--text-2` 500 with a bottom `--border`, rows 40px with `--border` dividers, hover `--surface-2` on rows that link somewhere, `tabular-nums`. `.table-scroll` is always the wrapper. A row whose first cell is a link gets `cursor: pointer` on the row and the whole row navigates via a delegated click handler: Ctrl/Meta opens a new tab, Shift/Alt do nothing, and it ignores controls, a click that ends a text selection, and cells marked `.copy` (a SHA, a commit message — the first click of a double-click would otherwise navigate). Middle-click is left to the first-cell link itself, which is a real anchor.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tabs        | `.tabs` `<nav aria-label>`                                             | Links, not ARIA tabs (they are navigation). 40px tall, `--text-2`, active `--text` with a 2px `--ink` underline; `aria-current="page"` on the active one. `overflow-x: auto` with hidden scrollbar so five tabs fit a phone. Labels are written in the template, not derived from the slug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Dialog      | `dialog` + `.dialog-wide`                                              | Keep the current enter/exit. Add `--shadow-3`, `--r-lg`, padding `--s-6`, a `.dialog-head` with the title, `.dialog-foot` for the button row. Body scrolls inside `max-height: 88vh` for every dialog, not only the wide one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Key/value   | `.kv`                                                                  | As today, values in mono where they are identifiers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Empty state | `.empty`                                                               | Icon from the sprite (`i-mark`, 32px, `--text-2`), `h2`, one paragraph at `--prose-w`, one primary action. Compact variant `.empty-sm` for inside a section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Logs        | `.logs`                                                                | Height `min(70vh, 720px)` on the deployment page, `min(60vh, 560px)` on the tab. `scrollbar-gutter: stable`. Stays dark in both modes (a terminal is dark), with the colours moved to tokens `--term-bg` / `--term-fg` / `--term-err`. `.logs-empty` message rendered server-side when there are no lines and hidden by the panel on the first appended line. "Jump to latest" becomes a `.btn.btn-sm` floating inside the panel's bottom-right rather than in the header, so it is next to where the eye is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Sidebar     | `.sidebar` `.nav-*`                                                    | Unchanged structure. Brand row gets the wordmark (6.4). Env rows get a 6px status dot (landed in slice 5a): the worst state among the environment's resources, in the order failed > unhealthy > deploying > queued > healthy > stopped, toned and hollowed by the same `.status-*` rules as the status component, with the words in a visually hidden `(Label)` so the link reads "production (Failed)". An environment with no resources keeps a blank slot. Known blind spots, all from what is not stored: `unhealthy`, and the reconciler's Deploying while a health check is `starting`, are live-only, so a reload shows Healthy; a resource stopped and then failing a redeploy reads Stopped; a dead container reads Healthy, and again after its reconcile redeploy fails, because `containerId` is never cleared; a deploy interrupted by a fast restart reads Deploying until its row is recovered (tracked separately). A row under the foot holds the RSS instrument. Active item: `--surface-2` background and `--text`, a 2px `--ink` bar on the left edge instead of a blue tint. |
| Page head   | `.page-head`                                                           | Breadcrumb row (quiet links, `/` separators from `::before`), then a title row: `h1` + status on the left, an `.actions` group on the right that wraps below 600px of container width. Uses a container query, not a viewport query, because the sidebar makes viewport width the wrong measure. Markup: `.page-head` > `nav.crumbs[aria-label=Breadcrumb] > ol > li` (every crumb but the last an `a.link-quiet`, the last `aria-current="page"`), then `.page-title` (`h1` + status), then `.actions`. Separators are `content: "/" / ""`, so browsers without alt-text support drop them and the gap still separates. Top-level pages (Projects, Settings) have no crumbs. Crumbs and titles wrap anywhere, so a 60-character name never scrolls the page.                                                                                                                                                                                                                                                                                                                                      |

### 6.4 Wordmark and favicon

The wordmark is plain text: `musdash` in the UI face at 600 with tight
tracking. The mark is a **single 16px SVG glyph**, a rounded square outline
with a smaller filled square inside it (a container inside a box), drawn in
`currentColor` and added to the sprite as `i-mark`. It is the favicon (as an
SVG data URI), the brand row in the sidebar, and the header of the login and
setup pages. Under 200 bytes. The favicon repeats the geometry (a data URI
cannot reach the sprite) and carries its own `prefers-color-scheme` rule, so
the tab icon is dark ink on a light browser and light on a dark one.

### 6.5 JavaScript additions (all in `public/app.js`)

- **Pending state** (~12 lines): on any form `submit` that is not prevented,
  the submit button gets `aria-busy` and is disabled on the next tick;
  `pageshow` clears it so a back-navigation from bfcache does not leave a dead
  button. It keys on `aria-busy`, so a button the server rendered disabled
  stays disabled. Verified in Chromium only; Firefox's form-state restoration
  on a non-bfcache back navigation is unchecked.
- **Dialog openers and closers** (~10 lines): `data-open="dialog-id"` and
  `data-close` delegated click handler replaces every inline `onclick`.
  Openers also carry `commandfor`/`command="show-modal"` and closers
  `commandfor`/`command="close"`, so browsers with Invoker Commands need no JS
  at all; the handler skips when `"command" in HTMLButtonElement.prototype`.
- **Row links** (~12 lines): see Table.
- **Log empty message** (~2 lines): hide `.logs-empty` on first append.

Net change is well inside the 16 KB budget.

---

## 7. Page-by-page plan

### Login and setup

Centred column, `max-width: 400px`. Mark and wordmark above the card; under
setup, the one-line promise as the tagline. Fields per 6.3 (`autocomplete`,
`autocapitalize="none"`, `spellcheck="false"` on email). The error notice sits
inside the card above the fields. Nothing else: no illustration, no split
layout.

### Projects

- Header: `h1` + primary "New project".
- Cards: name in the UI face at `--t-lg`, description as `--text-2`, a meta
  row with environments and resources. Hover per Card.
- Empty state per 6.3, keeping the current copy.
- Dialog: fields per 6.3; the `pattern` fix from finding 1.

### Project

- Tabs labelled **Resources** and **Variables**.
- Each environment is a section with a head row that wraps (finding 6): name,
  then actions. "Add resource" primary, "From repository" default.
- Resource card: name (UI face, as stored, finding 8) and `.status` on
  one row; image in mono; meta row with domains and memory.
- Variables tab: the three scope textareas stay, laid out with a container
  query (`.scope-boxes` goes to one column below 640px of container width).
  The "Currently set" key list moves from inline prose into a row of mono
  chips so a set of eight keys is scannable.
- Dialogs: fields per 6.3; the git dialog gets a `.dialog-head` and keeps its
  bounded repo list. The local-directory `<details>` stays.

### Resource

- Page head per 6.3: breadcrumb, `h1` + `.status`, actions group (Deploy
  primary, Rollback and Stop default) that wraps.
- Tabs: **Overview · Logs · Variables · Domains · Settings**.
- Overview: left card is a `.kv` of the facts the user asks first: URL (or
  the empty hint), Image, Previous image, Port, Health path, Memory. Right
  card is the deployments `.table` in `.table-scroll` (finding 2), rows
  clickable, status as `.status`, the commit message column keeps its `22ch`
  clip.
- Logs: per 6.3 with the empty message.
- Variables: resolved table as `.table`; scope as `.chip`, origin as
  `.chip-outline`; the editor card is the same layout as the project's.
- Domains: the automatic domain as a `.kv` row with a "Copy" quiet button; the
  custom list as rows with the hostname in mono and a quiet danger "Remove";
  the add form as a field plus a default button on one wrapping row.
- Settings: source `.kv` and auto-deploy checkbox as today; the settings form
  per 6.3; the delete card as `.card-danger`.

### Deployment

- Breadcrumb: Projects / project / environment / resource / Deployment
  (finding 16; the route already holds `ctx.project` and `ctx.environment`,
  the UI-Builder passes them through).
- `h1` "Deployment" with the image reference in mono beneath it at `--t-sm`
  (finding 7), `.status` beside the heading, the started time and duration in
  a `.kv` strip. "Back to resource" as a quiet button in the actions slot.
- Logs panel at page height per 6.3; the deployment error, when present,
  rendered as a `.notice-error` **above** the log, not below a 700px panel.

### Settings

- A **status strip** at the top: three `.kv` rows with a `.status` each,
  Dashboard address (set / not set), HTTPS (on / off), GitHub (connected /
  not connected). Every value the page already computes. This is what the
  user opens Settings to check.
- Each card keeps its form, and its explanatory prose moves under a
  `<details>` titled "How this works" so the page stops being a wall of text.
  Cards are capped at `--prose-w`.
- Notices re-toned: DNS mismatch and unreachable proxy stay `-error`; "no
  domain yet" and "restart not available now" become `-info`; "env file is
  shadowed" becomes `-warn`.
- Restart: disabled per Button spec, with the reason as the hint beneath.
- Installations as a `.table` (account, installation id).

---

## 8. Slices, in order

Each slice is one session, one commit, run through the repo's loop (research →
spec → approval → build → verify → validate). Slices 1–3 change no route
behaviour. Where a slice needs data a route does not pass today, it is listed
so the spec can assign it.

| #   | Slice                       | Files                                                                                                                                                                                                                                   | Acceptance criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Out of scope                                                                                            |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0   | **Defects**                 | `projects.eta`, `project.eta`, `resource.eta`, `deployment.eta`, `app.css`                                                                                                                                                              | No `pattern` console error on any page; submitting `My App` as a resource name is blocked by the browser. Resource overview at 390px has no horizontal scroll. `:disabled` buttons render at 50% opacity with `not-allowed`. `.env-head` wraps at 390px. Deployment `h1` is 24px. `color-scheme: light dark` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Everything visual beyond these                                                                          |
| 1   | **Tokens and base**         | `app.css`, `layout.eta`                                                                                                                                                                                                                 | One `:root` block using `light-dark()`; no hex literal outside it. Type, space, radius, motion scales exist and are used by every rule that had a literal. `:focus-visible` ring on every interactive element, verified by tabbing through each page. Skip link present. Every text/background pair ≥ 4.5:1 in both modes. `bun run ci` includes the asset-size gate and passes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Component redesigns, template rewrites                                                                  |
| 2   | **Components**              | `app.css`, `app.js`, `layout.eta` (sprite, notice), all pages for class renames                                                                                                                                                         | `.btn`, `.field`, `.card`, `.status`, `.chip`, `.notice`, `.table`, `.tabs`, `dialog` per 6.3, each used in at least one page. `.pill`, `.flash`, `.iconbtn`, `table.deployments`, `table.env-table` no longer exist. Pending state visible on every submit. No inline `onclick` remains. Status labels are sentence case and the dot pulses only for deploying/queued and not under reduced motion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Page layouts, Settings restructure                                                                      |
| 3   | **Shell**                   | `layout.eta`, `app.css`, `app.js` (`drawer`), `render.ts` (`rssMb`; status partial import renamed `statusPartialSrc` so it cannot collide with main's `status` page), the five page heads, `src/routes/app.ts` (`layout()` helper only) | Wordmark and favicon per 6.4. Sidebar foot shows the RSS instrument labelled "dashboard", value from `process.memoryUsage.rss()` passed by `layout()`. Active nav item uses the ink bar (landed early, in slice 1). Page-head pattern with container-query wrapping in place on every page. Mobile drawer and bar restyled with the tokens. **Result:** RSS is MiB labelled MB (the unit `gate:rss` measures) and sits in its own row under the foot, not inside it; the resource page's environment crumb became a link to `/p/{id}#env-{id}` so every non-final crumb is a link; the one-item Settings crumb was dropped; the drawer moves focus (Close on open, menu button on close; Escape inside a dialog closes only the dialog) and closes on a nav link click; `.card-title` wraps anywhere (pulled forward from slice 4). app.css 29,162 B, app.js 14,803 B. | Env status dots (needs `navTree()` to carry aggregated state; a Core-Builder change listed for slice 5) |
| 4   | **Projects and project**    | `projects.eta`, `project.eta`, `app.css`, this plan                                                                                                                                                                                     | Per §7. Resource names render in the case they were typed. Variables tab keys appear as chips. Every dialog uses `data-open`/`commandfor`. **Result:** keys render as neutral mono chips in a `dl.kv` "Currently set" row (values never reach the page); the scope boxes use `.field` markup and sit three across only when their form is ≥ 640px wide (container query on `form:has(> .scope-boxes)`, which also reaches the resource editor; slice 5 moves that editor to `.field` and deletes the `.scope-boxes > label` rule); card titles on `/` and the Variables tab are `h2`; the empty state carries `i-mark`; memory reads "512 MB"; Save reads "Save variables". Known exception, not fixed here: an invalid env line is echoed in `envError` (a Core-Builder fix). app.css 29,800 B, app.js unchanged.                                                     | Resource page                                                                                           |
| 5   | **Resource and deployment** | `resource.eta`, `deployment.eta`, `src/routes/app.ts` (pass `project`/`environment` to the deployment page; `navTree()` aggregation if the Core-Builder has landed it)                                                                  | Per §7. Overview `.kv` and clickable deployment rows. Logs empty message on both panels. Deployment breadcrumb is five levels. Error notice above the log. Handed over from slice 4: move the Variables editor to `.field` markup (as project.eta), delete the `.scope-boxes > label` rule, and relabel its Save button "Save variables" to match the confirm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Log timestamps, copy button, search                                                                     |
| 6   | **Settings**                | `settings.eta`, `src/settings-view.ts` only if a value is missing                                                                                                                                                                       | Status strip at top. Notices toned per §7. Prose under `<details>`, cards ≤ `--prose-w`. Restart disabled with reason as hint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | New settings                                                                                            |
| 7   | **Auth pages and polish**   | `login.eta`, `setup.eta`, `app.css`, `layout.eta`                                                                                                                                                                                       | Login and setup per §7. `@view-transition` active and disabled under reduced motion. Optional: theme toggle in the sidebar foot (three-state, localStorage, `data-theme`, set before first paint by a 3-line inline script in `<head>`), recorded in `docs/DECISIONS.md` since PHASES.md §11 said "no toggle in Phase 1".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Anything that adds a request                                                                            |

**Data the routes do not pass today** (the UI-Builder must not add queries;
the spec assigns them):

| Need                                                     | Who          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rssMb` in layout data                                   | UI-Builder   | `process.memoryUsage.rss()` in `layout()`; in scope for `src/routes/**`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `project`, `environment` on the deployment page          | UI-Builder   | Already computed as `ctx` in the handler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Aggregated resource state per environment in `navTree()` | Core-Builder | **Done in slice 5a**, built by the main thread; the wider scope (changing first-paint labels on the project and resource pages) was approved by the spec reviewer on the user's behalf, under the user's standing instruction to take the recommended option, not by the user directly. One statement: the nav join extended to resources with a correlated subquery for each resource's latest deployment status, folded through `resourceState()` (`src/resource-state.ts`), which also replaced `uiState()` on the project and resource pages so the dot, the card and the head never disagree. First paint now says Failed, Queued or Deploying where it used to say Stopped. |
| Container RSS for Caddy and BuildKit                     | Phase 4      | Belongs with "container resource usage display". Until then the instrument shows the dashboard process only, labelled as such.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 9. Verification

Testing in this repo is deliberately minimal and the UI is verified by hand,
so each slice ends with the same walk, recorded in the slice report:

1. `bun run ci` passes, including the asset-size gate from slice 1.
2. Screenshots of every page at 1280px and 390px, light and dark, taken with
   the Playwright MCP against a scratch data directory exactly as this review
   was (`MUSDASH_DATA_DIR=<scratch> MUSDASH_PORT=8765 bun run src/index.ts`;
   Docker need not be running, deploys simply fail and that exercises the
   failed state).
3. The browser console is empty of errors on every page.
4. No page has a document width wider than the viewport at 390px.
5. Tab through each page: every focusable element shows the ring, the order
   matches the visual order, Escape closes any open dialog or drawer.
6. Contrast of every text/background pair in both modes, checked with the
   DevTools colour picker or an equivalent; note any pair below 4.5:1.
7. `prefers-reduced-motion: reduce` emulated: no pulse, no transitions, no
   view transition.
8. Idle RSS is unaffected by design (assets are embedded strings), but the
   release gate `bun run gate:rss` still runs on the Linux box before the
   phase is called done, as CLAUDE.md requires.

The review screenshots that informed this document were taken outside the
repository and are not committed.

---

## 10. Sources

Current guidance consulted for this plan. Repository rules take precedence
wherever the two disagree.

- Modern CSS with no build step (Baseline status of `light-dark()`,
  container queries, `:has()`, nesting, `@starting-style`, view transitions,
  popover, anchor positioning):
  [flaviocopes.com](https://flaviocopes.com/modern-css-features/),
  [alexcloudstar.com](https://www.alexcloudstar.com/blog/modern-css-2026-features/),
  [youngju.dev](https://www.youngju.dev/blog/culture/2026-05-16-web-standards-2026-container-queries-view-transitions-popover-anchor-positioning-css-nesting-deep-dive.en),
  [riadkilani.com](https://blog.riadkilani.com/2026-css-features-you-must-know/),
  [kvassiliou.com](https://kvassiliou.com/tech/css-anchor-positioning-popover-api-2026)
  (anchor positioning noted as still uneven, which is why this plan does not
  use it), [calmops.com](https://calmops.com/web/modern-css-features/).
- WCAG 2.2: Target Size (Minimum) 24×24 at AA, Focus Appearance at AAA, Focus
  Visible at AA: [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/),
  [Level Access checklist](https://www.levelaccess.com/blog/wcag-2-2-aa-summary-and-checklist-for-website-owners/),
  [TestParty](https://testparty.ai/blog/wcag-22-new-success-criteria),
  [Monotonomo fix list](https://www.monotonomo.com/journal/wcag-2-2-brand-sites-2026/).
- Dashboard design: 14–16px body, 4.5:1 contrast, breadcrumbs and sticky
  orientation, real-time updates expected:
  [UXPin](https://www.uxpin.com/studio/blog/dashboard-design-principles/),
  [Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards).
- Design tokens in vanilla CSS, naming by purpose, layered tokens:
  [Penpot](https://penpot.app/blog/the-developers-guide-to-design-tokens-and-css-variables/),
  [UXPin](https://www.uxpin.com/studio/blog/what-are-design-tokens/),
  [The Spicy Web](https://www.spicyweb.dev/css-nouveau/1-vanilla-has-never-tasted-so-hot/4-design-tokens-from-the-ground-up/),
  [DEV Community](https://dev.to/sabrielagency/css-architecture-that-actually-scales-design-tokens-custom-properties-and-the-systems-that-hold-22n3).
- UX guideline database (ui-ux-pro-max skill): colour-alone, focus states,
  inline error placement, submit feedback, empty states, loading feedback,
  table overflow, toast timing. Its design-system query for a developer
  dashboard returned a dark-only OLED style with a green accent and
  JetBrains Mono / IBM Plex Sans; this plan deliberately keeps both modes,
  reserves green for status, and uses system fonts, for the reasons in §5.
