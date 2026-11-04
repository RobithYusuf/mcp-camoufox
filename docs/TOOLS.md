# mcp-camoufox — all 135 tools

The authoritative tool reference. Every tool the server registers is listed here with its
parameters and behaviour; the [README](../README.md) carries the category summary.

Anything that adds, removes or changes a tool must update this file in the same change.

---

### Browser Lifecycle (4)


| Tool              | Description                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_launch`  | Launch stealth browser. Options: `url`, `headless`, `humanize`, `geoip`, `locale`, `width`, `height`, `fresh_profile`, `no_viewport`. `**width`/`height` size the WINDOW** — the viewport is ~80px shorter because of browser chrome; the launch reply now prints viewport/window/screen so there's no guessing. If a browser is already running these options are ignored — `browser_close` first to relaunch. |
| `browser_close`   | Close browser. Reports exactly what survived — e.g. *"3 persisted, 1 session-only (dropped)"* — so a lost login is never a mystery. Temp profile removed if `fresh_profile` was used.                                                                                                                                                                                                                           |
| `reset_profile`   | Wipe the persistent profile at `~/.camoufox-mcp/profile` (browser must be closed first)                                                                                                                                                                                                                                                                                                                         |
| `browser_recover` | Escape hatch when the browser is wedged and `browser_close` can't finish: force-drops the connection, resets state, and reports a profile lock held by another Camoufox                                                                                                                                                                                                                                         |


### Navigation (4)


| Tool         | Description                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| `navigate`   | Go to URL. Options: `wait_until` (domcontentloaded/load/networkidle), `timeout` |
| `go_back` | Back in history. An error when there is no previous page. |
| `go_forward` | Forward in history                                                              |
| `reload`     | Reload page                                                                     |


### DOM &amp; Content (7)


| Tool               | Description                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_snapshot` | Get interactive elements with ref IDs. **Call after every navigation.** On large pages narrow with `roles=["button","textbox"]` or paginate with `offset`/`limit` — refs stay stable.                                 |
| `screenshot`       | Capture viewport, full page, or **one element** (`ref` / `selector` — perfect for documenting a modal). Returns the **image inline** plus the saved path, so no second read step. `return_image=false` for path only. |
| `get_text`         | Text from page or selector (max 5000 chars)                                                                                                                                                                           |
| `get_html`         | HTML from page or selector (max 10000 chars)                                                                                                                                                                          |
| `get_url`          | Current URL + title                                                                                                                                                                                                   |
| `save_pdf`         | ⚠️ Not available on Camoufox — Playwright implements PDF generation only for headless Chromium, and Camoufox is Firefox. Returns a clear error; use `screenshot(full_page=true)` instead.                             |
| `search_page`      | Grep the current page's visible text with surrounding context — costs nothing next to a snapshot or screenshot                                                                                                        |


### Element Interaction (12)


| Tool                   | Description                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click`                | Click by ref ID. Options: `button`, `dblclick`. If the real mouse click is blocked, it falls back to a full synthetic pointer sequence (`pointerdown`→`mousedown`→`pointerup`→`mouseup`→click) **and says so** — a degraded click is never reported as a clean one. |
| `click_text`           | Click by visible text. **Refuses to guess:** several matches → fails with a numbered candidate list (tag, text, ancestor path, ref). Narrow with `within` (`"@dialog"`, a CSS selector, or `"ref:e5"`) or choose with `index`.                                      |
| `click_role`           | Click by ARIA role + name. Same `within` / `index` / ambiguity guard as `click_text`.                                                                                                                                                                               |
| `hover`                | Hover over element                                                                                                                                                                                                                                                  |
| `fill`                 | Fill input/textarea — always **replaces** the old value (`email`/`number` inputs are cleared explicitly first; Firefox's select-all is a no-op on those, which otherwise made a re-fill append)                                                                     |
| `select_option`        | Select from dropdown                                                                                                                                                                                                                                                |
| `check` / `uncheck`    | Toggle checkbox/radio                                                                                                                                                                                                                                               |
| `upload_file`          | Upload file to input                                                                                                                                                                                                                                                |
| `click_element_offset` | Click at an x%/y% position inside an element — wide labels whose real checkbox sits at the left edge, sliders, split buttons                                                                                                                                        |
| `click_at_corner`      | Click a corner (close/X, delete, dismiss controls live there, not in the centre)                                                                                                                                                                                    |
| `paste_text`           | Fill via a **real** clipboard paste (Ctrl/Cmd+V) so frameworks that only listen for `paste` — Svelte 5 / Solid runes, some Qwik forms — actually receive it                                                                                                         |


### Keyboard (2)


| Tool        | Description                                                                |
| ----------- | -------------------------------------------------------------------------- |
| `type_text` | Type char by char. Options: `delay`. For OTP, masked inputs, date pickers. |
| `press_key` | Key or combo: `Enter`, `Escape`, `Tab`, `Control+a`, `Meta+c`              |


### Mouse XY (6)


| Tool              | Description                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mouse_click_xy`  | Click at exact coordinates. Optional `steps` curves the pre-movement path (shape only — the event is still Playwright-synthesized, mozInputSource=0, not a hardware pointer)                                                 |
| `mouse_move`      | Move cursor to coordinates. Optional `steps` interpolates the path. Still a synthesized event, not a hardware-origin one                                                                                                     |
| `click_turnstile` | Playwright-click a Cloudflare Turnstile checkbox. Params: `offset_x` (default 30), `offset_y`, `wait_render_ms`, `max_attempts`. Reports the response token AND the final title/URL + whether a challenge still shows, flags a TEST sitekey, and errors when no token results — a Playwright click (mozInputSource=0) is often rejected by Cloudflare, so a landed click is not a passed challenge. For a real OS click that DOES pass interactive Turnstile on macOS, use `turnstile_coords` + `os_click_xy`; or reuse a cf_clearance via `storage_state_save/load`. |
| `turnstile_coords`| Locate a Turnstile checkbox and return its VIEWPORT `{found,x,y,width,height}` WITHOUT clicking. Pair with `os_click_xy` in a SEPARATE call — the frame-API locate touches the challenge iframe, which Turnstile rejects if it happens next to the click, so locate and click must be different MCP calls. |
| `os_click_xy`     | **Headed desktop.** Deliver a REAL OS cursor click at a VIEWPORT x,y — hardware-input origin (`mozInputSource=1`) that passes interactive Turnstile where a synthetic click fails. **macOS verified (CGEvent); Windows (SendInput) and Linux (xdotool/X11) implemented but not yet tested.** Click only (no locate/reads), so pass coords from a prior `turnstile_coords`. macOS needs Accessibility; if missing it opens the permission dialog, waits briefly to auto-click on grant, else parks the cursor on the target for a one-click human handoff. Windows/Linux need no permission but a real desktop session (Linux = X11, not Wayland). |
| `drag_and_drop`   | Drag between two elements                                                                                                                                                                                                   |


### Wait (7)


| Tool                  | Description                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait_for`            | Wait for selector or text (visible/hidden/attached/detached)                                                                                                                  |
| `wait_for_navigation` | Wait for a navigation to happen and finish. Counts one that finished in the last 2s. An error if none is seen within `timeout`. |
| `wait_for_url`        | Wait for URL pattern match. Wrap in `/…/` for regex; a bare `/path` is treated as a substring.                                                                                |
| `wait_for_response` | Wait for a response whose URL contains `url_pattern`. Credentials in the URL are masked. Pass `reveal_values=true` for the real values. |
| `wait_for_change`     | Wait until the page actually CHANGES and report what changed (url/title/DOM size/text) — the honest replacement for a fixed sleep after a click                               |
| `wait_for_request` | Block until the page ISSUES a matching request, to confirm an action fired its API call. Credentials in the URL and body are masked. Pass `reveal_values=true` for the real values. |
| `wait_for_any_of`     | Race several conditions (`selector`/`text`/`url_contains`/`title_contains`) — returns the first that matches so the agent can branch in one call. Ideal for post-login flows. |


### Tabs (4)


| Tool         | Description                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tab_list`   | List all tabs. Pages the site opens itself (`window.open` / `target=_blank`, e.g. OAuth popups) are auto-tracked and appear here too.                                   |
| `tab_new`    | Open new tab                                                                                                                                                            |
| `tab_select` | Switch tab by `index` or `url_contains` (first tab whose URL matches)                                                                                                   |
| `tab_close`  | Close tab by `index` (-1 = active) or `url_contains`. The active tab is tracked by identity, so closing a lower-indexed tab never silently switches you to another one. |


### Cookies (3)


| Tool            | Description                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cookie_list` | List cookies. Options: `domain` filter. Values are masked. Pass `reveal_values=true` for the real values. |
| `cookie_set`    | Set cookie with `expires_days`, `http_only`, `secure`, `same_site`. `**expires_days=0` (default) makes a session cookie that dies at `browser_close`** — pass a lifetime to keep a login across relaunches. |
| `cookie_delete` | Delete by exact `name` and/or `domain` (a domain covers its subdomains, not look-alikes). Empty = clear all. The count is read back from the browser. |


### Local Storage (3)


| Tool                 | Description             |
| -------------------- | ----------------------- |
| `localstorage_get` | Get all or a specific key. Keys named like a credential are masked. Pass `reveal_values=true` for the real values. |
| `localstorage_set`   | Set key-value           |
| `localstorage_clear` | Clear all               |


### Session Storage (3)


| Tool                   | Description                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `sessionstorage_get` | Get all or a specific key. Keys named like a credential are masked. Pass `reveal_values=true` for the real values. |
| `sessionstorage_set`   | Set key-value                                                              |
| `sessionstorage_clear` | Clear all sessionStorage for the origin (parity with `localstorage_clear`) |


### JavaScript (2)


| Tool                 | Description                                |
| -------------------- | ------------------------------------------ |
| `evaluate`           | Run JS in page context                     |
| `inject_init_script` | Inject script that runs on every page load |


### Element Inspection (5)


| Tool                 | Description                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_element`    | Full element info: tag, attributes, box, styles                                                                                             |
| `get_attribute`      | Get specific attribute                                                                                                                      |
| `query_selector_all` | Query multiple elements by CSS selector                                                                                                     |
| `get_links`          | Get all links with URL + text. Options: `filter`                                                                                            |
| `form_introspect`    | Whole-form analysis in one call: label, type, value, required/pattern/length, validation state, and the JS framework each field is bound to |


### Frames (2)


| Tool             | Description             |
| ---------------- | ----------------------- |
| `list_frames`    | List all frames/iframes |
| `frame_evaluate` | Run JS inside a frame   |


### Batch Operations (6)


| Tool                    | Description                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batch_actions` | Multiple actions in one call (click, fill, type, press, select, check, uncheck, wait). Stops at the first failure unless `stop_on_error=false`. A failed or malformed action makes the reply an error. |
| `fill_form`             | Fill multiple fields + optional submit                                                                                                                                                |
| `login_classic`         | Composite login for email→password forms (Google/Microsoft/generic). Auto email→Next→password→submit, optional TOTP 2FA (`totp_secret` or `totp_code`). Collapses 5–8 calls into one. |
| `navigate_and_snapshot` | Navigate + snapshot in one call                                                                                                                                                       |
| `smart_fill`            | Fill fields by **label text** (fuzzy) instead of refs — no snapshot needed; optional `submit_label`                                                                                   |
| `workflow_run`          | Run a list of tool calls in sequence; resumable via `start_at` after a failure                                                                                                        |


### Viewport (2)


| Tool                | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| `get_viewport_size` | Get width x height                                                           |
| `set_viewport_size` | Set an EXACT viewport after launch — the precise way to control content size |


### Scroll (2)


| Tool        | Description                                                               |
| ----------- | ------------------------------------------------------------------------- |
| `scroll` | Scroll up/down/left/right by pixel amount. Reports the distance really moved, including 0. |
| `scroll_to` | Scroll a specific element into view (`ref`/`selector`, `block` alignment) |


### Dialog (2)


| Tool                 | Description                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `dialog_handle` | Set the answer for the next alert/confirm/prompt on **any** tab, including later ones. Says so if a dialog already went by, because it applies to the next one. |
| `dialog_auto_handle` | PERSISTENT handler — stays armed across every dialog and every tab, including popups. `enabled=false` removes it |


### Accessibility (1)


| Tool                     | Description                              |
| ------------------------ | ---------------------------------------- |
| `accessibility_snapshot` | Accessibility tree for LLM understanding |


### Console &amp; Network (9)


| Tool                            | Description                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console_start` / `console_get` | Capture and retrieve browser console messages. Capture spans **all tabs** and follows newly opened tabs/popups (re-calling `console_start` resets cleanly — no listener stacking).                                                                   |
| `network_start` / `network_get` | `network_get` masks credentials in URLs (`reveal_values=true` shows them). Capture network requests across **all tabs** (follows tab switches + popups). `network_start(capture_bodies=true)` also records request/response headers + text bodies. `network_get(filter=...)` narrows by URL substring; each row shows an `#id`. |
| `network_get_detail` | Full request + response (headers + text body) for one captured request by `#id` or `url` substring. Needs `capture_bodies=true`. Cookie, Authorization, Set-Cookie, tokens and passwords are masked. Pass `reveal_values=true` for the real values. An error when no request matches. |
| `intercept_start` / `intercept_stop` | Abort requests before they leave the browser, by resource type (`image`, `media`, `font`, `stylesheet`, `script`, `xhr`, `fetch`, `websocket`) and/or URL pattern (`*doubleclick.net*`). Blocking images and stylesheets removes most of a typical page's bytes — the biggest single speed-up for scraping. Routed on the **context**, so tabs opened later are covered too. `document` cannot be blocked: that would abort the navigation itself. |
| `intercept_log` | What interception blocked and allowed, with the rule that matched each decision. Credentials in URLs are masked. Pass `reveal_values=true` for the real values. |
| `export_curl` | Rebuild a captured request as a `curl` command. Needs `capture_bodies=true`. Credentials become placeholders, so the command does not reproduce the call as is. Pass `reveal_values=true` for the real values. |


### Compound (reduce round-trips) (4)


| Tool                  | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `wait_and_snapshot`   | Wait for selector/text + return snapshot in one call                         |
| `back_and_snapshot`   | Navigate back + return snapshot                                              |
| `reload_and_snapshot` | Reload page + return snapshot                                                |
| `click_and_snapshot`  | Click + wait + return snapshot. Perfect for buttons that trigger navigation. |


### Smart Selectors (skip snapshot) (3)


| Tool                  | Description                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_by_text`        | Find by visible text — returns **every** match with a ref, ancestor path and total, so you can see whether the one you'd click is the one you mean. Supports `within`. |
| `find_by_label`       | Find input by label text, returns ref (lists all candidates if several match). Supports `within`.                                                                      |
| `find_by_placeholder` | Find input by placeholder, returns ref (lists all candidates if several match). Supports `within`.                                                                     |


### Session Portability (7)


| Tool                 | Description                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `cookie_export` | Export all cookies as JSON. Values are masked, and `cookie_import` refuses a masked export. Pass `reveal_values=true` to transfer, or use `cookie_export_file`, which writes a 0600 file. |
| `cookie_import`      | Import cookies from JSON (restore session)                                                    |
| `cookie_export_file` | Write all cookies to a JSON file (Playwright format)                                          |
| `cookie_import_file` | Load cookies from a JSON file (Playwright format)                                             |
| `storage_state_save` | Save cookies + localStorage + sessionStorage to JSON file. Reload to skip login/CF.           |
| `storage_state_load` | Restore session from JSON (cookies + storage). Use `navigate_to` param to apply localStorage. |
| `auth_capture`       | Convenience: save current session to `~/.camoufox-mcp/sessions/<name>.json`                   |


### Humanize / Anti-Bot (5)


| Tool                            | Description                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `humanize_click`                | 3-step Bezier mouse approach + small jitter before click. Scrolls the target into view first (a real mouse click can't reach an off-screen element). Use for CF/DataDome pages. |
| `humanize_type`                 | Gaussian-distributed keystroke delays (mean 80ms, sigma 30ms). Mimics human rhythm.                                                                                             |
| `mouse_drift`                   | Random mouse movements over duration — builds mouse history before action.                                                                                                      |
| `mouse_record` / `mouse_replay` | Capture human mouse path then replay (anti-bot gold).                                                                                                                           |


### Session Warmup &amp; Detection (2)


| Tool              | Description                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `session_warmup`  | Visit Google/Wikipedia (random) before targeting protected site. Helps IP scoring. |
| `detect_anti_bot` | Heuristic detection of CF/DataDome/Akamai/PerimeterX/Imperva/reCAPTCHA/hCaptcha. Also reports `challenged`: whether the page is currently a block/verification interstitial vs. a vendor merely present on already-passed content. |


### Assertions (4)


| Tool                     | Description                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `assert_element_visible` | PASS/FAIL — element exists and is visible                                                         |
| `assert_text_present`    | PASS/FAIL — text substring on page                                                                |
| `assert_url_matches`     | PASS/FAIL — URL matches pattern (substring or regex)                                              |
| `assert_clickable`       | Hit-test **without clicking**: would a real click land? Names the element that would intercept it |


### Workflow Helpers (3)


| Tool                    | Description                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `click_and_wait`        | Click + wait for navigation/selector atomically (fewer roundtrips)                                                                                                                   |
| `wait_for_network_idle` | Wait until there are zero in-flight requests for `idle_ms` continuously (tracked per request — the threshold really is yours, not Playwright's fixed 500 ms)                         |
| `describe_page`         | Compact LLM-friendly summary (title, h1, buttons, links, forms) + `intent` classifier (`login_email`, `otp_input`, `captcha`, `stay_signed_in`, …) — cheaper than `browser_snapshot` |


### Scraping &amp; Extraction (4)


| Tool                     | Description                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `detect_content_pattern` | Auto-detect repeated content (cards, listings) and suggest CSS selectors. **Run this before `extract_structured`.**              |
| `extract_structured`     | Extract data from repeated elements as clean JSON. Auto-deduplicates, filters empties, `direct_text_only` prevents field mixing. |
| `extract_table`          | Extract HTML table as JSON array with auto-detected headers                                                                      |
| `scrape_page`            | Smart scraper: auto-extract main content (strips nav/footer), links, meta, headings. Smart truncation at paragraph boundary.     |


### Browserless HTTP (5)

The browser is the expensive path. `impit` (already shipped with camoufox-js) speaks a real **Firefox** TLS/HTTP2 fingerprint, so these tools fetch without launching anything — and the fingerprint matches the browser this server actually drives. Verified against a Cloudflare-protected site that these tools cleared **without opening a browser at all**.

> No SERP scraping here by design: scraping a search page without an API returns confidently wrong results for whole classes of query (Bing answers any "how does …" question with dictionary pages) and one major engine is TLS-blocked by some ISPs. `search` exists instead — it talks to a real search API you control, which has no such failure mode. Feed its URLs to `scrape_markdown` to read the sources.


| Tool                   | Description                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_request` | HTTP with a real Firefox TLS fingerprint, reusing the live browser's cookies by default. Set-Cookie, tokens in JSON or form bodies and tokens in URLs are masked. Pass `reveal_values=true` for the real values. |
| `http_session_cookies` | Show which browser cookies would be sent to a URL. Values are masked. Pass `reveal_values=true` for the real values. |
| `scrape_markdown`      | One URL → clean LLM-ready markdown (headings/links/lists kept, nav/footer/scripts stripped). Browserless by default, `use_browser=true` for JS-heavy pages |
| `smart_fetch`          | Tries HTTP first, escalates to the stealth browser **only** when the response looks anti-bot blocked. The efficiency core                                  |
| `search` | Search through an API **you** control — self-hosted SearXNG, or Brave/Tavily/Exa with a key — returning a normalised title/url/snippet list. Set `MCP_SEARCH_ENDPOINT` once. Never scrapes a result page. |


### Storage Inspection (4)


| Tool               | Description                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `storage_snapshot` | Capture cookies + localStorage + sessionStorage into a named slot                              |
| `storage_diff` | Diff current state against that slot, to find which key holds a session token. Cookie values and credential-named storage keys are masked. Pass `reveal_values=true` for the real values. |
| `indexeddb_list`   | List IndexedDB databases for the origin (where many SPAs hide auth state)                      |
| `indexeddb_delete` | Delete an IndexedDB database by name                                                           |


### Debug (6)


| Tool                   | Description                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server_status` | Health check: browser status, tab count, URL with credentials masked, the profile in use (`profile_dir`, `profile_is_temp`), and `last_exit` if the browser died. |
| `get_page_errors`      | Uncaught JS errors + unhandled promise rejections, captured by a hook installed at `browser_launch`. Buffer resets on every navigation — read it before navigating away. |
| `export_har` | Export captured traffic as a **HAR 1.2** file, mode 0600. Needs `network_start` first and is an error with nothing captured. Credentials are masked. Pass `reveal_values=true` for the real values. |
| `page_stats`           | Element count, page size, load metrics + extraction strategy recommendation                                                                                              |
| `performance_timeline` | TTFB, DOMContentLoaded, load, FCP, LCP + the 5 slowest resources (CLS is unavailable — Firefox has no layout-shift API)                                                  |
| `fingerprint_audit`    | The fingerprint a site actually sees (user-agent, platform, languages, timezone, screen vs window, cores, WebGL, `navigator.webdriver`), and flags **contradictions between those values** — a viewport larger than the screen, a Chrome object on a Firefox UA, a platform that disagrees with the user-agent. Self-consistency only: it cannot tell you whether a given site's detector passes you. |


### Site Automation (2)


| Tool                     | Description                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatgpt_generate_image` | End-to-end image generation/edit on chatgpt.com in one call: fresh chat → optional reference-image upload → prompt → wait for the finished image → save PNG to `output_path`. Requires an authenticated chatgpt.com session. |
| `chatgpt_generate_batch` | Many images in parallel (one tab per job, submit-all-then-collect). `shared_image_paths` + `style_suffix` keep a set visually consistent.                                                                                    |
