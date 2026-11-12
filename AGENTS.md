# mcp-camoufox — Agent Guide

This guide applies to the entire repository and is the shared source of instructions for coding agents.
Its purpose is not to govern every decision, but to preserve the workflows and invariants that are easy
to miss — most of them were learned from a shipped bug. Developer requests may override working
defaults; hard constraints may only be overridden when the developer explicitly asks for it.

## Product and repository map

An MCP server (stdio JSON-RPC) that gives an agent a stealth browser: 135 tools over Camoufox, a
Firefox build with C++-level anti-fingerprinting. Published on npm as `mcp-camoufox`.

```
npx -y mcp-camoufox → Node → camoufox-js → Playwright (Juggler) → Camoufox Firefox
                           └→ impit (Firefox JA4 TLS) → browserless HTTP path
```

- `src/index.ts` — entry: connects stdio, imports the tool modules.
- `src/state.ts` — the single mutable record `S`, page bookkeeping, shared capture buffers.
- `src/helpers.ts` — refs, clicks, fills, snapshots, paths, TOTP.
- `src/redact.ts` — what a reply may show of a credential. Every masking decision lives here.
- `src/lifecycle.ts` — finding, stopping and proving gone a browser process; temp profile cleanup.
- `src/install.ts` — finding and downloading the Camoufox browser itself. No tool imports, so a test can load it.
- `src/identity.ts`: the device a persistent profile keeps across launches. No tool imports, so a test can load it.
- `src/os-input.ts` — real OS cursor clicks for `os_click_xy`.
- `src/server.ts` — the `McpServer` instance and the `regTool` registry, with the guarantees every tool shares.
- `src/tools/*.ts` — the tools, grouped by area; each registers itself on import.
- `scripts/test/` — the regression suites and the protocol sweep; `scripts/*.mjs` — release checks.
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
- camoufox-js and playwright-core are never imported at the top of a module. They were 190ms of a 270ms
  `initialize`, paid even by a session that only uses the HTTP tools. `browser_launch` loads them through
  `loadCamoufox()` and `refEngineReady()`, and `warmBrowserModules` loads them 200ms after the client's
  `initialized` notification, so a launch that comes later does not wait either. A type-only import is fine.
  `suite-docs` reads the server's imports through a resolve hook and fails on an eager one.
- `regTool` wraps every handler: a throw becomes an `isError` reply with credentials scrubbed, a call
  past its deadline answers instead of hanging (`page.evaluate` has no timeout), and a dialog answered
  during the call is named in a separate content item, so `evaluate`'s own text stays exactly its result.

### Credentials in replies

- A tool that can print a cookie, header, URL or body masks it through `redact.ts` by default and takes
  `reveal_values=true`. Secret form fields go through `SECRET_FIELD_FN` and have no reveal option.
- Playwright failures quote the element, including its `value` attribute, so `fill` on a disabled
  password field printed the password. `scrubErrorText` handles that in `regTool`, and `fillLocator` cuts
  the typed value from its own errors.
- `cookie_import` refuses a masked export. It would overwrite a real login with the placeholder.
- Not masked, on purpose: `evaluate` output, and page URLs from `navigate`, `get_url` and `tab_list`,
  which an agent has to be able to use. A secret in free text under an ordinary name is not detectable.

### Refs, clicking and filling

- A ref lives in a registry in the page's isolated world (`Symbol.for("mcp.camoufox.refs")`, a Map of
  WeakRefs), never in the DOM. The `mcpref=` selector engine resolves it, and `refLocator(page, ref)` is the
  only place that selector is written. Refs used to be `data-mcp-ref` attributes: 16 attribute mutations per
  snapshot on a small page, and `document.querySelector("[data-mcp-ref]")` told a site who was driving it.
  A tool that needs a ref for an element uses `REF_PUT_FN`; it does not call `setAttribute`. The engine still
  honours an attribute a test or a page sets itself. `selectors.register` must run before the context exists,
  so `browser_launch` awaits `refEngineReady()`.
- Refs are numbered before any role/offset/limit filtering, so they stay stable. A label whose field is
  listed gets no row and no number: the field carries it as `label="…"`. A label for a hidden checkbox keeps
  its row, because it is the thing to click. So does a label for a control that passes the size filter but no
  real click reaches (`standIn`: 1px or less, `opacity:0`, `clip`/`clip-path`). A Tailwind `sr-only` checkbox
  lost its label row, and nothing left in the snapshot could be clicked for real.
- Elements inside visible iframes get refs with a frame prefix (`f1e3`). They live in that frame's own
  registry, and `refLocator` looks the frame up in `frameRefs`, filled by the last snapshot. At most
  `MAX_SNAPSHOT_FRAMES` frames and `MAX_FRAME_ELEMENTS` each, and the snapshot says when it stopped, and when a
  frame could not be read (a frame that reloads now and then answers "Execution context was destroyed").
- "Visible" for a frame is asked of the element that holds it, up the chain (`frameShown`). From inside, a
  frame under `visibility:hidden`, in an `opacity:0` wrapper or parked at `top:-10000px` looks visible, so
  its buttons were listed and the fallback fired their handlers. `clickObstacle(loc, true)` asks the same
  of a frame ref that was hidden after the snapshot.
- Open shadow roots are read by `snapshotJs` with the same selector, and their elements are listed right after
  their host with ordinary refs in the same registry. Labels are looked up in the field's own root
  (`getRootNode()`): an `aria-labelledby` id inside a shadow root is not the document's. At most
  `MAX_SHADOW_ROOTS` roots and `MAX_SHADOW_DEPTH` levels per document, and the snapshot says when it stopped. A
  closed shadow root cannot be read from a page and is not forced. `PAGE_SIGNATURE_JS` hashes open shadow roots
  too, because `outerHTML` leaves them out and a component that changed its own content read as a dead click.
  Finding hosts touches every element (2.5ms on a 5,800-element page against 0.45ms for `outerHTML`), so the
  reading before a click scans and the readings after it reuse that list. Anything that hit-tests a point asks
  the element's own root (`root.elementFromPoint`): from the document, everything in a shadow root is its host.
- `pageSignature` reads the main document plus the frame of the clicked ref only (`frameOfRef`), each part
  with its own deadline; a part that cannot be read is unknown, not a change. Hashing every frame the last
  snapshot listed made an iframe that changes by itself (a playing video, a rotating ad) turn every dead
  click into "Page content changed", and a failed fallback into a success.
- `clickWithFallback` returns `{mode, blocker}` and every click tool appends `clickNote(result)`. A
  blocked click must never read as a clean one. The fallback replays the full pointer sequence
  (`pointerover/pointerdown/mousedown/pointerup/mouseup` then `el.click()`), because a bare
  `el.click()` does nothing on Radix, Headless UI and MUI.
- The fallback is only for a left click on a visible, enabled element something covers. A disabled element
  ignores it, a hidden one fires a handler no user could reach, and a blocked right or double click used to
  replay as a LEFT click. Those three are refused and nothing is fired. So is an element nothing covers that
  the real click still cannot reach ("element is outside of the viewport", never stable): a link at
  `left:-9999px` is what a honeypot looks like, and the fallback used to click it.
- Synthetic events take `view` from `el.ownerDocument.defaultView`, never the global `window`. In Camoufox's
  isolated world the global is not a Window, every event constructor refuses it, and the whole fallback threw
  "'view' member of UIEventInit does not implement interface Window" after five seconds.
- A click learns what it can before clicking. A ref that names nothing and a disabled control are refused at
  once (a disabled one gets 400ms to enable). The real click then gets `QUICK_CLICK_MS` (1.5s), not the full
  timeout: Playwright retries a covered element for the whole timeout and only then says why, so every refused
  click cost five seconds. An element that is merely still moving gets the rest of `ACTION_TIMEOUT`.
- A click Playwright already sent is never repeated. Playwright counts the wait for a navigation the click
  started inside the click's own timeout, so a form whose server took 2.5s timed out the 1.5s quick click
  after it was sent. The retry then found the new document's empty registry and answered "Element not found"
  for a click that worked, or sent the form a second time. A call log with "click action done" or "waiting
  for scheduled navigations" means delivered (`clickDelivered`).
- `observeClick` waits for a main-frame navigation request the click started and that is still open, up to
  `ACTION_TIMEOUT` more, and says so if the server never answers. Camoufox reports `framenavigated` a few
  milliseconds AFTER `requestfinished`, so a finished request gets `COMMIT_GRACE_MS` (250ms) in either phase.
  Ending the wait on `requestfinished` reported "No page change" for a form that navigated. That was seen once
  in the suite and 0 times in 64 isolated clicks, so no test pins the grace: do not remove it as dead code.
- A dialog is a reaction. `observeClick` used to report "No page change observed within 1000ms" directly above
  the note that an alert had appeared. Only the clicked tab's dialogs count (`DialogEntry.page`): an alert
  looping in another tab was reported as this click's reaction. After a dialog the page is watched for
  `DIALOG_FOLLOW_MS` (300ms) more, so an accepted confirm that navigates reports the navigation too.
- `observeClick` reports what the page did: navigated, content changed, opened a tab, or nothing. It compares
  a hash of the HTML plus form state. Comparing lengths reads a counter going 1 to 2 as no change. Focus is
  not a reaction and scroll is excluded, because Playwright scrolls the target into view first. A fallback
  click that changed nothing is an error.
- `page.mouse` knows nothing about what is under it. Tools aiming at an element by coordinates run
  `hitTestAt` first, a Playwright trial click, so a covered element is refused instead of reporting a clean
  click the cover received.
- `locator.evaluate` needs a real function. A string is evaluated and never called on Firefox, and the tool
  quietly gets undefined. To splice `SECRET_FIELD_FN` in, build one with `elementFn(body)`.
- Each snapshot starts a new registry, so a ref from an earlier snapshot names nothing. With attributes a
  hidden element kept its old ref, one ref named two elements, and `.first()` could pick the hidden one.
- `click_text` and `click_role` refuse to guess: more than one match fails with a numbered candidate
  list. `within` (`"@dialog"`, a CSS selector, or `"ref:e5"`) or `index` disambiguates. Taking
  `.first()` once clicked a page header's "Cancel" instead of the dialog's and destroyed a filled form.
- Always fill through `fillLocator`. Firefox's select-all is a no-op on `input[type=email]` and
  `[type=number]`, so a plain `locator.fill()` appends to the old value. It restores the old value when the
  fill then fails: clearing first used to wipe disabled and readonly fields while reporting an error.
- `formatSnapshot` caps its element list at `MAX_SNAPSHOT_CHARS` (60k). A 6,000-element page produced a
  566,000-character response with no warning at all; it now stops and prints the exact `offset=` call to
  continue, plus the `roles=` and `extract_structured` alternatives.
- Secret-looking fields (type=password, or `pass|secret|token|otp|cvv|card|pin` in name/id/autocomplete/
  aria-label, `SECRET_FIELD_FN`) are masked everywhere they could surface: `fill`, `cookie_set`,
  `login_classic`, `browser_snapshot` and `inspect_element`. The snapshot splices `SECRET_FIELD_FN` in rather
  than keeping its own regex, and masks a select's chosen option too: once a select printed its chosen option,
  `name="card_exp_month"` showed the card's expiry month.
- `smart_fill(within=…)` with a scope that names nothing (a stale ref, a missing selector, a frame ref) is an
  error. It used to widen silently to the whole page and fill a field of the same name somewhere else.

### JavaScript worlds

- Camoufox now runs `page.evaluate` in an isolated world: the DOM is shared, the page's own JavaScript is not.
  `window.someAppVariable` is undefined there and a page function cannot be called. `browser_launch` detects it
  (`S.evalIsolated`, true when `window.wrappedJSObject` exists) because an older build still evaluates in the
  page's world. 0.12.0 assumed the page's world, and on a fresh install the sweep marked 25 of them BUG.
  `detectEvalWorld` answers null when it cannot ask; the launch asks again after the first navigation and
  otherwise says in its reply that it does not know. A failure used to read as "the page's own world".
- On such an old build the ref registry is in the page's world too, and `Symbol.for` is a global registry:
  the page can read `window[Symbol.for("mcp.camoufox.refs")]` or swap the Map. Only the isolated world hides it.
- The server's own reads (snapshot, click checks, page signature, hit tests) stay on plain `page.evaluate`.
  That is what makes them invisible: a page that wraps `querySelector` or `getBoundingClientRect` sees zero
  calls. Do not move them to the page's world to reach something.
- Code the CALLER wrote goes through `evalMain`, which adds Camoufox's `mw:` prefix: `evaluate`,
  `frame_evaluate` and `inject_init_script`. Both evaluate tools take `world="isolated"`. The launch passes
  `main_world_eval: true` to allow the prefix; nothing runs in the page's world unless a tool is asked to.
- A property the PAGE put on an element (`__reactFiber…`, `__vue__`) is not visible from the isolated world.
  Read it through `el.wrappedJSObject`, as `form_introspect` does.
- An init script without the prefix runs in the isolated world. A listener it adds still fires, which is why
  the page-error hook works, but a global it defines never reaches the page.
- State the server keeps in a page (`__mcp_errors`, the mouse recorder, the ref registry) belongs in the
  isolated world. A test reads it with `evaluate(world="isolated")`; read through the default world it is
  undefined and the check passes without checking anything.

### Navigation

- Every navigation goes through `gotoReady` / `waitReady` in `helpers.ts` — never `page.goto` with a
  lifecycle `waitUntil`. They commit the navigation and then poll the document, because the events
  Playwright would otherwise wait for stop arriving (see the Camoufox facts below). `networkidle` uses
  the same per-page in-flight counter as `wait_for_network_idle`, not the equally dead lifecycle event.
- `settle` asks only 30ms of quiet from a document that has already fired `load` with nothing in flight, and
  the full 200ms from one still loading. Waiting 200ms on every page was most of `navigate`: 259ms against 60.
  A request the page starts while loading is still waited for; one started later from a timer is not.
- A navigation is followed by `settle(page, capMs)`, never a blind `waitForTimeout`. Each navigation
  used to sleep a flat 1000ms (1500 in launch and navigate_and_snapshot) — a guess from when nothing
  here could tell whether a page was ready. Measured against a local fixture that was 85% of the whole
  call: 1113ms for `navigate` versus 166ms for `tab_new` doing the same work without it. `settle`
  watches the same in-flight counter and returns as soon as the page is quiet, keeping the old duration
  only as the worst case. `navigate` now costs ~315ms locally and ~545ms on a real site.
- Do NOT use `settle` after a click or a form submit. It measures network quiet, and right after a
  click the request often has not left yet — it would return before the thing it is meant to wait for
  even starts. The fixed sleeps in `fill_form` and `login_classic` are deliberate for that reason.
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
- Dialogs have one listener per page, attached by `trackPage`, reading `S.oneShotDialog` then
  `S.autoDialogCfg`. A registered listener suppresses Playwright's auto-dismiss, so it must answer every
  dialog or that page blocks forever. A dialog cannot stay open to be answered later: `dialog_handle` armed
  too late says one already went by, and applies to the next.
- `console_start`/`network_start` attach to every page and detach any previous handler first, so
  re-calling never stacks listeners. `browser_close` nulls the handler refs and clears the buffers.
- `browser_launch` claims its launch slot synchronously before the first `await`. The SDK dispatches
  requests concurrently, and two launches otherwise each build a context — the loser unreachable by
  `browser_close`.

### Browser lifecycle

- "Closed" is a claim about a process. `stopBrowser` closes the context, then checks `ps` for `-profile <dir>`,
  and escalates to signals only against this server's own descendants on that exact profile. A shared pattern
  would hit a browser another agent or the developer is using. Windows has no such listing, so the reply says
  the exit could not be verified.
- A persistent profile keeps one device (`identity.ts`): the browserforge fingerprint and a WebGL
  vendor/renderer pair, stored 0600 as `mcp-identity.json` inside the profile, so `reset_profile` removes it
  with the logins. Ten launches of one persistent profile used to be ten different devices with the same
  cookies. Store camoufox-js's INPUT, never its output: `fromBrowserforge` writes the installed browser's
  version into the user agent, and a stored `navigator.userAgent` passed through `config` would keep claiming
  the version it was drawn under. An `os` other than the stored one, or a window the stored screen cannot hold,
  draws a new device and the reply says why. A stored pair camoufox-js does not know made every launch fail ("No
  WebGL data found") until the logins were deleted, so it is checked before reuse and replaced. The font-spacing
  and canvas seeds are not stored: pinned, they changed nothing measured. A temp profile stays random. The
  fingerprint and WebGL sampler are deep imports of camoufox-js 0.10 internals; when they move, the launch still
  works with a random device and its reply carries a ⚠ line.
- A temp profile is removed only when no process is on it (`removeTempProfile`).
- The context's `close` event resets all state. Without it a crashed browser left `browser_up: true` and
  `browser_launch` refusing forever. All state is cleared in one place, `resetBrowserState`.
- Closing every tab leaves the browser alive, so `browser_launch` opens a tab in it instead of a second browser.
- `index.ts` shuts down on stdin end as well as on signals. A client that crashes only closes stdin, and the
  browser's pipes then keep the server alive forever. Playwright's signal handlers are off so ours can finish.
- Temp folder names carry the owner's PID (`profile-fresh-p<pid>-…`). The next launch removes one whose owner
  is dead and that no process is on. Older names have no owner to check and are only counted in `server_status`.

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
- Camoufox sporadically never commits a navigation — measured at roughly 1-2% of them, on new tabs and
  existing pages alike. `gotoReady` asks the document whether it arrived before believing the timeout,
  and `tab_new` discards a tab whose first navigation never committed and retries on a fresh one. Do
  NOT re-issue `goto` on a page whose navigation is still in flight: both calls then fail, which broke
  every CSP navigation when it was tried. A 30s timeout from `navigate` is this flake — retry it.
- `camoufox.cfg` sets `browser.sessionhistory.max_entries` to 0, which turns history off: `page.goBack` answers
  null and `history.back()` does nothing, even over a pushState entry, while every reply said "Went back".
  `browser_launch` sets it to 50, stock Firefox's value. `history.length` proves nothing either way:
  camoufox-js randomises it.
- Once the pointer has been inside a page, `page.mouse.move` to y in [0, 1) is never answered (Playwright floors
  it to 0; y=1 and y=-5 are fine), and later mouse calls on that tab wait behind it. A stepped move crossing the
  top edge lands on 0 only sometimes, which looked like a random wedge for months. Always use `pointerMove` and
  `pointerClick`, which hold y at 1 or more.
- The canvas noise cannot be pinned through camoufox-js. On an http page even a filled rectangle hashes
  differently in every launch with the fingerprint, `canvas:aaOffset` and `canvas:seed` all fixed; within one
  launch it is stable, and about:blank has none. `audio:seed` is not set either: the audio fingerprint measured
  the same across launches without it.
- Left to itself Camoufox picks the fingerprint OS at random: Windows 64%, macOS 29%, Linux 8% of 300 draws.
  On a macOS host a Windows or Linux fingerprint took 5.2-5.9s to launch against 1.0-1.8s, used about 450 MB
  more, and still listed macOS speech voices (`urn:moz-tts:osx:…`) under a Windows user agent. `browser_launch`
  defaults to `os="auto"`, the host's own. Measured on macOS only.
- `dom.webnotifications.enabled=false` removes `window.Notification`. No desktop Firefox lacks it, and
  bot.sannysoft.com's script threw on it: 37 rows rendered with 2 failed, against 57 rows with 1 failed (a
  Chrome-only check) once the pref was dropped. `permissions.default.desktop-notification=2` alone denies
  without a prompt and leaves the API in place.
- The generated screen is constrained to hold the window (`screen: {minWidth, minHeight}`). Unconstrained, 26
  of 300 fingerprints had a screen smaller than 1280x800, and a window cannot be resized after launch. A size
  no screen has makes the generator throw "No headers based on this input", so that case retries without it. It
  does not always throw: asked for 5000x3060 it quietly handed back 1920x1080 (windows) and 2056x1329 (macos), so
  a drawn screen is checked against the window before it is stored (`identity.ts`), and the viewport fit after
  launch covers the rest.
- The bundled uBlock Origin costs about 350 MB and roughly doubles a navigation on a fresh profile
  (example.com cold 926ms against 384ms). It stays on by default because it removes far more than that on
  an ad-heavy page; `ublock=false` is there for the pages that have none.
- Install the browser with the camoufox-js this package depends on (`bundledFetchCommand`), never
  `npx camoufox-js fetch`: that resolves to the newest camoufox-js, and 0.13 stores the browser in a layout
  0.10 cannot read, so a first launch downloaded 1.3 GB and then failed (issue #7).
- `version.json` survives the browser being deleted, and camoufox-js trusts it. `ensureCamoufoxBinary` checks
  the executable, and a missing one is downloaded like a first install. Refusing with a command to paste
  was tried in 0.13.0 and left the developer asking why it would not just download.
- The download runs in the background (`spawn`), never `execFileSync`. Blocking took about five minutes in
  which the server answered nothing, not even `server_status`, and a client with a 60s tool timeout gave up
  while the download went on. `browser_launch` waits `DOWNLOAD_WAIT_MS` (40s), then answers with the parsed
  progress and asks to be called again; it checks before creating any profile folder, so those calls leave
  nothing behind. A failed download says why and the next launch retries. `stopDownload` runs on exit.
- `MCP_CAMOUFOX_FETCH_COMMAND` (a JSON argv) and `MCP_CAMOUFOX_DOWNLOAD_WAIT_MS` exist for the tests, which
  stand a short script in for the 1.3 GB fetch. Nothing else should set them.
- Every launch passes its own fingerprint (`tempIdentity` or `profileIdentity`) through `withRealInnerSize`.
  fingerprint-generator 2.1.82 left `screen.innerWidth/innerHeight` at 0, which camoufox-js skips; 2.1.90,
  what a fresh install resolves, sets them to the window's OUTER size. Camoufox then reported innerHeight 800
  in a page laid out in 720: no browser chrome, and an innerHeight that disagrees with
  `documentElement.clientHeight`. It shipped in 0.13.0 because the repo's lockfile still had 2.1.82: the
  same lesson as the playwright-core pin. `npm update` the transitive generator packages before a release,
  and run `smoke:install`, which uses what a user gets. `fingerprint_audit` flags the mismatch.
- A headed launch follows the window by default (`no_viewport` defaults to `!headless`). A fixed viewport in
  a window a person resizes left empty space instead of reflowing. Following the window was safe only once
  the fingerprint's screen could hold it: `display.ts` reads every display (AppKit through `osascript` on
  macOS, about 0.1s and no prompt; PowerShell on Windows and xrandr on Linux, both untested) and the
  launch asks for a screen at least as large as the largest one. Measured before: a 1512x982 spoofed screen
  and a window dragged to a 2560x1440 monitor gave a 2560x1325 page, flagged twice by fingerprint_audit;
  after, a 2560x1440 screen and an audit with no contradiction. Headless keeps the fixed viewport.
- `normalizeUrl` (in `gotoReady` and the HTTP tools) turns a bare `example.com` into `https://example.com`,
  and `localhost` or an IP address into `http://`. A new user's first `browser_launch(url="example.com")`
  launched the browser and then failed with Playwright's "Invalid url".
- Playwright starts a headed Firefox with `-foreground`, which takes keyboard focus from whatever the developer
  is typing in. `browser_launch` drops it with `ignoreDefaultArgs`.
- `page.waitForURL` waits for the load event by default, and `waitForLoadState` for a lifecycle event, so both
  break after the fifth page. Use `waitForUrl` and `waitReady`.
- `setViewportSize` with a non-positive size hangs and leaves the page with no usable viewport, after which every
  real click fails its actionability check. `set_viewport_size` validates first.
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
- `width`/`height` in `browser_launch` size the window **and** the viewport (width matches, height is
  80px shorter — the measured chrome). Passing `window` alone left Playwright's default 1280x720
  viewport in place, so `width=1400` produced outerWidth 1400 with innerWidth 1280: 120px of horizontal
  chrome that Firefox does not have, and any script can subtract the two. `fingerprint_audit` now flags
  that gap.
- A fixed viewport never follows the OS window, so dragging the frame wider adds empty space instead of
  reflowing. That is Playwright's model, not a bug — `set_viewport_size` after the resize, or
  `no_viewport: true` to track the window live, which then can exceed the spoofed screen (an anti-bot
  tell the launch reply warns about).
- Camoufox randomises the spoofed `screen` per profile and sometimes picks one SMALLER than the default
  1280x720 viewport, which makes the viewport exceed its own screen — an anti-bot tell that appears by
  chance rather than by configuration. `browser_launch` and `set_viewport_size` both warn when it
  happens. Never hard-code a "safe" viewport in a test; derive it from `screen.width/height`.
- `cookie_set` without `expires_days` creates a session cookie that Firefox never writes to disk — it
  dies at `browser_close` even though the profile persists.
- npm `overrides` only apply to the root project, so ours do not reach a user's tree. Do not claim the
  dependency audit is clean for users.

## Documentation on demand

- `docs/TOOLS.md` is the authoritative tool reference — every tool, with its parameters — and must be
  updated in the same change that adds, removes or modifies a tool, including the `### Category (N)`
  count in its heading. `README.md` carries the group tables, the tool count, the test results and the
  troubleshooting rows; update those too when they are affected.
- README wording: plain language, measured results with their limits. A demo on a Cloudflare test sitekey
  (`1x`, `2x`, `3x`) is not proof of passing a real site. No advice to `pkill` a browser or delete a profile.
  `npm run audit:tools` enforces what it can.
- Run `npm run audit:tools` instead of counting by eye. It diffs the live `tools/list` against
  `docs/TOOLS.md` and the README's counts, and exits non-zero on a mismatch. Both failure modes it
  catches had already happened: a tool documented nowhere, and a heading that still said "Debug (5)"
  while its table listed six.
- A tool description is read by the model on every request: all of `tools/list` goes into every prompt.
  It says what the tool does, what a parameter value means when the name does not, what has to happen
  first (`network_start(capture_bodies=true)` before the request, `dialog_handle` before the action), and
  every warning that prevents damage (`reset_profile` deletes logins, `reveal_values` prints credentials).
  Bug history, measurements and design reasons go in `docs/TOOLS.md`. `suite-docs` caps the size of
  `tools/list` (`TOOLS_LIST_BUDGET`); raise it in the change that needs the room, not to make it pass.
  Most of what is left is schema the SDK emits (`$schema` and `execution` on every tool, about 3,200
  tokens), not prose.
- Record a decision here when it is non-obvious and would otherwise be re-litigated or re-broken.

## Verification and debugging

```bash
npm test                 # five suites, real browser over MCP stdio, sandboxed HOME
npm run test:sweep       # EVERY tool over a real MCP client, effects read from the page (minutes)
npm test -- core         # one suite
npm test -- --parallel   # all at once; each owns its browser and port
MCPC_ONLY=snapshot npm test -- core   # only checks whose name matches — debugging aid, NOT a verification
npm run test:schema      # dump every tool name/description/schema
npm run smoke:install    # install the PUBLISHED package and drive a real browser
npm run audit:tools      # diff docs/TOOLS.md + README against the live tool registry, plus README wording rules
npm run smoke:real       # drive real sites (CSP, inline SVG, 6 tabs, interception) — run before publishing
```

- Use evidence proportional to the risk, but a change to a shared helper means the whole suite.
- `suite-footprint` reads what the PAGE saw: its fixture wraps the DOM functions a detector would wrap and
  counts calls that did not come from its own scripts, plus every mutation. A claim that something is
  invisible to the page belongs there, measured, not in a comment.
- A check that reads a file must read it from the server's HOME (`S.home`), not `homedir()`. The 0600 check
  read the developer's real home, where a file from before the sandbox existed kept it green for weeks.
- A new Camoufox build can change behaviour under a green suite: the isolated world arrived that way. After
  the browser is updated, run the sweep before trusting anything.
- A new tool needs an entry in `scripts/test/sweep.mjs`: one success path and one failure path, with the effect
  read back from the page. The sweep fails on a tool with no entry. It found `go_back` moving nowhere since the
  first release while 98 checks stayed green, because those checks read the words in the reply.
- `MCP_TEST_DIST=<path>/dist/index.js npm run test:sweep` runs the sweep against another build, which is the
  quick way to prove a check fails without its fix.
- A local fixture is not a real site. Three bugs shipped while the local suite was green: `eval()`-based
  polling died on every strict CSP, `browser_launch` produced a viewport no real window could have, and
  `detect_content_pattern` threw on any inline SVG. No fixture had a CSP header, a window manager or an
  SVG. `npm run smoke:real` drives the actual web and belongs in the release order; it found a real
  fingerprint bug on its very first run. It is deliberately NOT part of `npm test` — the open web is not
  deterministic and must never gate a release on someone else's outage.
- `suite-footprint` serves its iframes from a second fixture server on another port: another origin, with
  no dependence on how the machine resolves `localhost` (fixtures listen on 127.0.0.1 only).
- After editing `src/`, run `npx tsc` and reconnect the MCP client — a local registration points at
  `dist/index.js`, so an unbuilt change means you are testing the old build.
- Before a refactor, snapshot the tool surface and diff it afterwards. On its first real use this
  caught a rename leaking into English prose inside three tool descriptions — something TypeScript
  cannot see.
- Release order: `npx tsc` → `npm test` → `npm run test:sweep` → `npm run smoke:real` → version bump →
  `npm publish` → `npm run smoke:install`
  against the published version → commit and push.
- The suites use `fresh_profile: true` and a throwaway HOME, so they cannot reach `~/.camoufox-mcp`. Pass
  `geoip: false` when launching: the default calls a public IP service.
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
