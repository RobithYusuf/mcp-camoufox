# mcp-camoufox — Agent Guide

This guide applies to the entire repository and is the shared source of instructions for coding agents.
Its purpose is not to govern every decision, but to preserve the workflows and invariants that are easy
to miss — most of them were learned from a shipped bug. Developer requests may override working
defaults; hard constraints may only be overridden when the developer explicitly asks for it.

## Product and repository map

An MCP server (stdio JSON-RPC) that gives an agent a stealth browser: 133 tools over Camoufox, a
Firefox build with C++-level anti-fingerprinting. Published on npm as `mcp-camoufox`.

```
npx -y mcp-camoufox → Node → camoufox-js → Playwright (Juggler) → Camoufox Firefox
                           └→ impit (Firefox JA4 TLS) → browserless HTTP path
```

- `src/index.ts` — entry: connects stdio, imports the tool modules.
- `src/state.ts` — the single mutable record `S`, page bookkeeping, shared capture buffers.
- `src/helpers.ts` — refs, clicks, fills, snapshots, paths, TOTP.
- `src/server.ts` — the `McpServer` instance and the `regTool` registry.
- `src/tools/*.ts` — the tools, grouped by area; each registers itself on import.
- `scripts/test/` — the regression suites; `scripts/*.mjs` — release checks.
- `docs/TOOLS.md` — the authoritative tool reference. `README.md` — the summary and the pitch.
- `docs/images/` — proof screenshots.
- Runtime data lives outside the repo: `~/.camoufox-mcp/{profile,screenshots,sessions}`.

## Hard constraints

- Never commit or print a credential. The npm token is set into `~/.npmrc` immediately before
  `npm publish` and deleted immediately after; `.npm-token` and `*.tgz` stay ignored.
- Never publish from the working tree alone. A release is only verified once
  `npm run smoke:install` has installed the **published** package and driven a real browser.
- `playwright-core` must stay pinned `<1.61.0`. Playwright 1.61+ sends `isMobile` in
  `Browser.setDefaultViewport`, which Camoufox's Juggler schema rejects, and camoufox-js declares
  the peer as `"*"`. Unpinning breaks `browser_launch` for every fresh install while this tree
  keeps working.
- Do not weaken a security property to make a test pass: secret field values never leave the browser,
  credential files are written `0600`, name parameters never escape their directory, and browser
  cookies are recomputed per redirect hop.
- Do not add a tool that can fail silently. If an action may not have taken effect, the response says
  so — see the click/wait invariants below.
- `reset_profile`, `browser_recover` and anything that deletes a profile need an explicit request; the
  shared profile holds the developer's real logins.

## Working defaults

- Understand the affected flow, then make the smallest coherent change that solves the problem.
- Prefer the existing shared helpers (`refLocator`, `fillLocator`, `clickWithFallback`, `snapshotPage`,
  `jsStr`, `resolveOutPath`) over a local variant. A new tool that hand-rolls one of these will drift
  from the fixes the others already carry.
- Verify claims by running them. Several bugs in this repo survived for months because they were
  reasoned about rather than reproduced, and two "already fixed" reports turned out to be untested.
- Report honestly: if a check was skipped, say so; if a test crashed rather than passed, say that.
- The developer manages releases. Bump, publish and push only when asked.

## Architecture invariants

### State and registration

- All mutable state lives on the single exported record `S` in `state.ts`. An imported `let` binding
  cannot be assigned to from another module, so a plain export would silently split the state in two.
- Every tool registers through `regTool()`, never `server.tool()`. `regTool` stores `{schema, handler}`
  in `toolRegistry` so `workflow_run` can invoke any tool by name with the same zod validation and
  defaults a real MCP call gets. It is typed as `typeof server.tool`, so handler arguments keep their
  inference.
- `PKG_VERSION` is read from `package.json` via `createRequire`, so the MCP handshake version cannot
  drift from the published one.

### Refs, clicking and filling

- `browser_snapshot` injects `data-mcp-ref` attributes; `refLocator(page, ref)` is the only place that
  selector is written. Refs are numbered before any role/offset/limit filtering, so they stay stable.
- `clickWithFallback` returns `"real" | "fallback"` and every click tool appends `clickNote(mode)`. A
  blocked click must never read as a clean one. The fallback replays the full pointer sequence
  (`pointerover/pointerdown/mousedown/pointerup/mouseup` then `el.click()`), because a bare
  `el.click()` does nothing on Radix, Headless UI and MUI.
- `click_text` and `click_role` refuse to guess: more than one match fails with a numbered candidate
  list. `within` (`"@dialog"`, a CSS selector, or `"ref:e5"`) or `index` disambiguates. Taking
  `.first()` once clicked a page header's "Cancel" instead of the dialog's and destroyed a filled form.
- Always fill through `fillLocator`. Firefox's select-all is a no-op on `input[type=email]` and
  `[type=number]`, so a plain `locator.fill()` appends to the old value.
- `formatSnapshot` caps its element list at `MAX_SNAPSHOT_CHARS` (60k). A 6,000-element page produced a
  566,000-character response with no warning at all; it now stops and prints the exact `offset=` call to
  continue, plus the `roles=` and `extract_structured` alternatives.
- Secret-looking fields (type=password, or `pass|secret|token|otp|cvv|card|pin` in name/id/autocomplete)
  are masked everywhere they could surface: `fill`, `cookie_set`, `login_classic`, `browser_snapshot`
  and `inspect_element`.

### Navigation

- Every navigation goes through `gotoReady` / `waitReady` in `helpers.ts` — never `page.goto` with a
  lifecycle `waitUntil`. They commit the navigation and then poll the document, because the events
  Playwright would otherwise wait for stop arriving (see the Camoufox facts below). `networkidle` uses
  the same per-page in-flight counter as `wait_for_network_idle`, not the equally dead lifecycle event.
- `tab_new` calls `trackPage` and sets the active page **before** navigating. The tab exists the moment
  `newPage()` returns, so tracking it only after a successful `goto` left a dead tab nobody could
  select or close.

### Tabs, capture and dialogs

- `browser_launch` registers `ctx.on("page", trackPage)`, so pages the *site* opens (`window.open`,
  `target=_blank`, OAuth popups) are tracked automatically. `trackPage` is idempotent, removes a page
  on `close`, arms the per-page in-flight request counter, and re-attaches console/network/dialog
  handlers to new tabs.
- The active tab is tracked by page **identity**, not index. Closing a lower-indexed tab must not move
  "active" to a different page.
- A one-shot `dialog_handle` arms tabs opened later too (`S.oneShotDialogHandler`, armed by `trackPage`).
  It tells the persistent handler to stand down globally, so arming only the tabs that existed at the
  time left a dialog on a newer tab with no handler at all — and a registered listener suppresses
  Playwright's auto-dismiss, blocking that page forever.
- `console_start`/`network_start` attach to every page and detach any previous handler first, so
  re-calling never stacks listeners. `browser_close` nulls the handler refs and clears the buffers.
- `browser_launch` claims its launch slot synchronously before the first `await`. The SDK dispatches
  requests concurrently, and two launches otherwise each build a context — the loser unreachable by
  `browser_close`.

### The browserless HTTP path

- `impit` presents a real Firefox JA4 (`t13d1715h2…`), matching the browser this server actually
  drives. `http_request`, `scrape_markdown` and `smart_fetch` never launch a browser; `smart_fetch`
  escalates only when `looksBlocked()` fires.
- Redirects are followed **manually**. impit replays a manually-set `Cookie` header onto the redirect
  target, so an open redirect handed the session cookie to another host. Cookies are recomputed per hop
  and caller credentials are dropped when the origin changes.
- `htmlToMarkdown` is regex-based on purpose — no jsdom or turndown dependency.
- `search` never reports an unreadable response as "no results". If the provider's container is missing
  it says so and prints the top-level keys it did get — a shape mismatch reported as an empty result set
  is the same confident lie this project keeps removing.
- No SERP scraping. `web_search`/`deep_research` shipped in 0.9.0 and were removed in 0.9.2: Bing
  answers any "how does …" query with dictionary pages for the word "does", DuckDuckGo is
  TLS-intercepted on some ISPs, and every alternative needs its own fragile parser. `search` is the
  sanctioned replacement — it requires an endpoint the user controls (self-hosted SearXNG, or
  Brave/Tavily/Exa with a key) and parses a documented JSON contract, never a result page. A new
  provider is welcome there; a new HTML scraper is not.

## Firefox and Camoufox facts

These are platform truths, not preferences. Each one cost a release.

- `page.evaluate` string arrow functions may not auto-invoke — use an IIFE, and `var` rather than
  `const`/`let` inside evaluate strings.
- Every value spliced into an evaluate string goes through `jsStr()` (`JSON.stringify`). A selector or
  key containing a quote, backslash or newline otherwise breaks the whole expression.
- Camoufox stops delivering the `load` and `domcontentloaded` lifecycle events after the **fifth page**
  in a context. Measured with a fresh browser per run: both events succeed 4 times, then time out every
  time after (8/12 at 30s), while `commit` plus a `document.readyState` poll passes 12/12 with the DOM
  verified present. Anything waiting on those events burns its whole timeout on a page that loaded
  fine — this silently broke `navigate`, `tab_new`, `reload` and `go_back` for anyone who opened five
  tabs. Never pass `waitUntil: "domcontentloaded"`/`"load"` to Playwright here; go through `gotoReady`.
- `page.url()` is a function, not a property.
- `mouse.wheel()` silently no-ops; scroll with `window.scrollBy` via evaluate.
- `page.pdf()` is Chromium-only and always throws here; `save_pdf` catches it and points at
  `screenshot(full_page=true)`.
- `boundingBox()` is viewport-relative — scroll into view before any `page.mouse.*` targeting, or a
  real click lands at negative coordinates and hits nothing.
- Firefox refuses synthetic `clipboardData`, so `paste_text` writes the real clipboard and presses
  `ControlOrMeta+V` (needs `dom.events.testing.asyncClipboard` at launch).
- `indexedDB.databases()` exists; `layout-shift` does not, so CLS is permanently unavailable.
- There is **no CDPSession for Firefox** — perf traces, coverage, heap snapshots and CPU/network
  throttling cannot be ported from mcp-stealth-chrome.
- `width`/`height` in `browser_launch` size the **window**; the viewport is ~80px shorter because of
  browser chrome. `set_viewport_size` is the exact control. `no_viewport: true` lets the content follow
  the real window but can exceed the spoofed screen, which is an anti-bot tell.
- `cookie_set` without `expires_days` creates a session cookie that Firefox never writes to disk — it
  dies at `browser_close` even though the profile persists.
- npm `overrides` only apply to the root project, so ours do not reach a user's tree. Do not claim the
  dependency audit is clean for users.

## Documentation on demand

- `docs/TOOLS.md` is the authoritative tool reference — every tool, with its parameters — and must be
  updated in the same change that adds, removes or modifies a tool, including the `### Category (N)`
  count in its heading. `README.md` carries the category summary, the hero count, the comparison table
  and the troubleshooting rows; update those too when they are affected.
- Run `npm run audit:tools` instead of counting by eye. It diffs the live `tools/list` against
  `docs/TOOLS.md` and the README's counts, and exits non-zero on a mismatch. Both failure modes it
  catches had already happened: a tool documented nowhere, and a heading that still said "Debug (5)"
  while its table listed six.
- Record a decision here when it is non-obvious and would otherwise be re-litigated or re-broken.

## Verification and debugging

```bash
npm test                 # 94 checks, three suites, real browser over MCP stdio
npm test -- core         # one suite
npm test -- --parallel   # all three at once (~27s vs ~52s); each owns its browser and port
MCPC_ONLY=snapshot npm test -- core   # only checks whose name matches — debugging aid, NOT a verification
npm run test:schema      # dump every tool name/description/schema
npm run smoke:install    # install the PUBLISHED package and drive a real browser
npm run audit:tools      # diff docs/TOOLS.md + README counts against the live tool registry
```

- Use evidence proportional to the risk, but a change to a shared helper means the whole suite.
- A local fixture is not a real site. The suites passed 94/94 while navigation was broken on every
  page with a strict `script-src`, because `page.waitForFunction` polls through `eval()` and no fixture
  sent a CSP header. There is a `/csp` route now — drive one real site before believing a green run.
- After editing `src/`, run `npx tsc` and reconnect the MCP client — a local registration points at
  `dist/index.js`, so an unbuilt change means you are testing the old build.
- Before a refactor, snapshot the tool surface and diff it afterwards. On its first real use this
  caught a rename leaking into English prose inside three tool descriptions — something TypeScript
  cannot see.
- Release order: `npx tsc` → `npm test` → `npm run audit:tools` → version bump → `npm publish` →
  `npm run smoke:install`
  against the published version → commit and push.
- The suites use `fresh_profile: true`; the shared profile may be locked by a browser the developer is
  already running.
- Every suite cleans up in a `finally` (browser closed, fixture closed, server killed) and takes an
  OS-assigned port. Both were added after crashed runs leaked Camoufox processes and left a fixed port
  bound, so the *next* run died on `EADDRINUSE` and the real failure was never visible.
- Prefer `until(fn)` from the harness over a fixed sleep: a hard-coded delay both wastes time when the
  event is instant and still fails on a slow machine.
- A hunt for an intermittent failure is over when the isolated repro is deterministic. The tab bug above
  looked like a 1-in-5 test flake for days; a 12-iteration script pinned it at 8/12 in under a minute.

## Maintaining this guide

Add a rule only when it records a non-obvious invariant, prevents an expensive failure, or addresses a
repeated correction. Prefer the specific symptom over the general principle — "a click result
containing ⚠ means the real click was blocked" is useful; "be careful with clicks" is not. When a rule
becomes specific to one module, move it next to that module instead of growing this file.
