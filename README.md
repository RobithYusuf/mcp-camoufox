<div align="center">

<img src="https://i.imgur.com/enUBkXt.png" alt="Camoufox" width="280">

# MCP Camoufox

![npm version](https://img.shields.io/npm/v/mcp-camoufox.svg)
![npm downloads](https://img.shields.io/npm/dm/mcp-camoufox.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)

</div>

The most feature-rich stealth browser MCP server. **133 tools** for full browser control powered by [Camoufox](https://github.com/daijro/camoufox) — a Firefox fork with C++ level anti-detection that bypasses Cloudflare, bot detection, and anti-automation.

> **One command. No Python. No manual setup. Everything auto-installs.**

```bash
claude mcp add camoufox -- npx -y mcp-camoufox@latest
```

## What Can It Do?

- Login to Google, ChatGPT, GitHub — without getting blocked
- Fill forms, click buttons, type text, upload files
- Manage cookies, localStorage, sessions across visits
- Take screenshots, export PDFs, capture network traffic
- Work with multiple tabs, iframes, dialogs
- Execute JavaScript, inspect elements, scroll pages
- Scrape structured data (job listings, products) with auto-detected selectors
- All while being **undetectable** by anti-bot systems

## Comparison


| MCP Server                                                      | Tools   | Stealth | npx Install | Persistent Session |
| --------------------------------------------------------------- | ------- | ------- | ----------- | ------------------ |
| Chrome DevTools MCP                                             | 30+     | No      | Built-in    | Yes                |
| whit3rabbit/camoufox-mcp                                        | 1       | Yes     | Yes         | No                 |
| redf0x1/camofox-mcp                                             | 47      | Yes     | Yes         | Yes                |
| Sekinal/camoufox-mcp                                            | 49      | Yes     | No (clone)  | Yes                |
| Playwright CLI                                                  | 60+     | No      | Yes         | Yes                |
| [**mcp-camoufox**](https://github.com/RobithYusuf/mcp-camoufox) | **133** | **Yes** | **Yes**     | **Yes**            |

<sub>Competitor figures checked 19 Aug 2026: camofox-mcp counted by running `tools/list` against v1.15.0 from npm (it is npx-installable — an earlier version of this table wrongly said otherwise); the others are taken from their own READMEs.</sub>


## Proven on Real Sites


| Site                                     | Challenge                   | Result                                                                             |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `2captcha.com/demo/cloudflare-turnstile` | Cloudflare Turnstile widget | ✅ **"Success!"** via `click_turnstile()` tool ([proof](docs/images/turnstile.jpg)) |
| `bot.sannysoft.com`                      | Firefox fingerprint tests   | ✅ All green ([proof](docs/images/sannysoft.jpg))                                   |
| `browserscan.net/bot-detection`          | WebDriver/UA/CDP/Navigator  | ✅ All categories "Normal" ([proof](docs/images/browserscan.jpg))                   |


### 🎯 Cloudflare Turnstile → Success via `click_turnstile()`

<img src="docs/images/turnstile.jpg" alt="Cloudflare Turnstile success" width="500">

`click_turnstile()` auto-detects the widget via 6 selector fallback (`iframe[src*=challenges.cloudflare.com]`, `[data-sitekey]`, `.cf-turnstile`, …), computes checkbox position (offset_x=30 from widget left), and clicks with a 3-step Bezier-like approach — combined with Camoufox's native `humanize` + `disable_coop` for cross-origin iframe click.

**Scope:** works on **Interactive Turnstile** (visible iframe widget). **Managed Challenge** interstitials ("Just a moment...") render the widget in shadow DOM — not supported here; use sister project [mcp-stealth-chrome](https://github.com/RobithYusuf/mcp-stealth-chrome) (Chrome+CDP) for those. Real-world bypass success also depends on IP reputation and browser fingerprint — code alone doesn't guarantee it.

### 🧪 bot.sannysoft.com → Firefox Fingerprint Pass

<img src="docs/images/sannysoft.jpg" alt="sannysoft Firefox pass" width="500">

User Agent reports `Firefox/135.0`, WebDriver missing, WebDriver Advanced passed, Permissions prompt, Plugins length 5 passed, Languages `en-US,en`, WebGL Intel HD Graphics — all green. ("Chrome: missing" is expected — Camoufox spoofs Firefox, not Chrome.)

### 🔍 browserscan.net/bot-detection → All Categories Normal

<img src="docs/images/browserscan.jpg" alt="browserscan normal" width="500">

WebDriver, User-Agent, CDP, Navigator — every detection category returns **"Normal"**. Camoufox's C++-level Firefox patches leave zero automation signals.

## Setup

One command for Claude Code:

```bash
claude mcp add camoufox -- npx -y mcp-camoufox@latest
```

Every other client takes the same server block — only the config file differs:

```json
{
  "mcpServers": {
    "camoufox": {
      "command": "npx",
      "args": ["-y", "mcp-camoufox@latest"]
    }
  }
}
```

| Client | Config file |
| --- | --- |
| Claude Code | `claude mcp add camoufox --scope user -- npx -y mcp-camoufox@latest` (drop `--scope user` for project-only) |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json` · Windows `%APPDATA%\Claude\claude_desktop_config.json` · Linux `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) |
| Windsurf | `~/.windsurf/mcp.json` or `.windsurf/mcp.json` — uses `"servers"` instead of `"mcpServers"` |
| VS Code (Continue / Cline / Kilo) | `~/.continue/config.json` or `.vscode/mcp.json` |
| Factory (Droid) | `~/.factory/mcp.json` or `.factory/mcp.json`, with `"type": "stdio"` — or `droid mcp add camoufox "npx -y mcp-camoufox@latest"` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` (global only) |

Two clients need a different shape:

```jsonc
// OpenCode — ~/.config/opencode/opencode.json ("local", not "stdio"; command is one array)
{ "mcp": { "camoufox": { "type": "local", "command": ["npx", "-y", "mcp-camoufox@latest"], "enabled": true } } }

// Trae — ~/.trae/mcp.json (mcpServers is an ARRAY)
{ "mcpServers": [ { "name": "camoufox", "command": ["npx", "-y", "mcp-camoufox@latest"] } ] }
```

### Requirements

**Node.js 18+ is the only prerequisite** (`node --version`). The Camoufox browser binary (~80 MB)
downloads itself on first launch — nothing else to install.

On **Windows** the same one-liner works; there is no standalone `.exe` because this is a Node package.
The browser lands in `%LOCALAPPDATA%\camoufox`, profile/screenshots/sessions in
`%USERPROFILE%\.camoufox-mcp\`, and output paths accept either `C:\path\file.json` or `C:/path/file.json`.

| Requirement | Version | Check            |
| ----------- | ------- | ---------------- |
| **Node.js** | 18+     | `node --version` |


That's all. Camoufox browser binary (~80MB) downloads automatically on first launch.

## All 133 Tools

Grouped by area. **[→ Full reference, every tool and parameter](https://github.com/RobithYusuf/mcp-camoufox/blob/main/docs/TOOLS.md)**

| Category | Tools | For example |
| -------- | ----- | ----------- |
| Browser Lifecycle | 4 | `browser_launch`, `browser_close`, `reset_profile` |
| Navigation | 4 | `navigate`, `go_back`, `go_forward` |
| DOM &amp; Content | 7 | `browser_snapshot`, `screenshot`, `get_text` |
| Element Interaction | 12 | `click`, `click_text`, `click_role` |
| Keyboard | 2 | `type_text`, `press_key` |
| Mouse XY | 4 | `mouse_click_xy`, `mouse_move`, `click_turnstile` |
| Wait | 7 | `wait_for`, `wait_for_navigation`, `wait_for_url` |
| Tabs | 4 | `tab_list`, `tab_new`, `tab_select` |
| Cookies | 3 | `cookie_list`, `cookie_set`, `cookie_delete` |
| Local Storage | 3 | `localstorage_get`, `localstorage_set`, `localstorage_clear` |
| Session Storage | 3 | `sessionstorage_get`, `sessionstorage_set`, `sessionstorage_clear` |
| JavaScript | 2 | `evaluate`, `inject_init_script` |
| Element Inspection | 5 | `inspect_element`, `get_attribute`, `query_selector_all` |
| Frames | 2 | `list_frames`, `frame_evaluate` |
| Batch Operations | 6 | `batch_actions`, `fill_form`, `login_classic` |
| Viewport | 2 | `get_viewport_size`, `set_viewport_size` |
| Scroll | 2 | `scroll`, `scroll_to` |
| Dialog | 2 | `dialog_handle`, `dialog_auto_handle` |
| Accessibility | 1 | `accessibility_snapshot` |
| Console &amp; Network | 9 | `console_start`, `console_get`, `network_start` |
| Compound (reduce round-trips) | 4 | `wait_and_snapshot`, `back_and_snapshot`, `reload_and_snapshot` |
| Smart Selectors (skip snapshot) | 3 | `find_by_text`, `find_by_label`, `find_by_placeholder` |
| Session Portability | 7 | `cookie_export`, `cookie_import`, `cookie_export_file` |
| Humanize / Anti-Bot | 5 | `humanize_click`, `humanize_type`, `mouse_drift` |
| Session Warmup &amp; Detection | 2 | `session_warmup`, `detect_anti_bot` |
| Assertions | 4 | `assert_element_visible`, `assert_text_present`, `assert_url_matches` |
| Workflow Helpers | 3 | `click_and_wait`, `wait_for_network_idle`, `describe_page` |
| Scraping &amp; Extraction | 4 | `detect_content_pattern`, `extract_structured`, `extract_table` |
| Browserless HTTP | 5 | `http_request`, `http_session_cookies`, `scrape_markdown` |
| Storage Inspection | 4 | `storage_snapshot`, `storage_diff`, `indexeddb_list` |
| Debug | 6 | `server_status`, `get_page_errors`, `export_har` |
| Site Automation | 2 | `chatgpt_generate_image`, `chatgpt_generate_batch` |

<sub>32 categories, 133 tools. The full table lives in
[docs/TOOLS.md](https://github.com/RobithYusuf/mcp-camoufox/blob/main/docs/TOOLS.md) so this page stays readable — nothing was dropped, and a script
checks both against the running server's tool registry.</sub>

## Examples

**Read a page without launching anything.** The browser costs seconds and ~400 MB; most fetches don't
need a DOM. `smart_fetch` only starts one if the response looks anti-bot blocked.

```
scrape_markdown(url="https://example.com/docs")     # clean markdown, no browser
smart_fetch(url="https://shop.example.com/item/42") # escalates only if blocked
http_request(url="https://api.example.com/v1/me")   # reuses the browser's cookies
```

**Log in, then hit the API cheaply.** Log in once with the browser, then stay browserless.

```
browser_launch(url="https://app.example.com/login")
smart_fill(fields_json='{"Email":"me@x.com","Password":"secret"}', submit_label="Sign in")
wait_for_change()                                   # returns when the page really reacts
http_request(url="https://app.example.com/api/orders")   # same session, no browser work
```

**Fill a form without a snapshot.** `smart_fill` matches by label; `form_introspect` tells you what a
form wants and why it is rejecting a submit.

```
form_introspect()                                   # labels, types, required, validation state
smart_fill(fields_json='{"Customer name":"Rina","E-mail address":"rina@x.com"}')
```

**Find out why a click did nothing** — before spending the click.

```
assert_clickable(selector="#submit")
# FAIL: covered by div.overlay — that element would receive the click
```

**Run a whole sequence in one call.** Resumable: a failure tells you the index to restart from.

```
workflow_run(steps=[
  {tool: "navigate", args: {url: "https://example.com"}},
  {tool: "smart_fill", args: {fields_json: '{"Search":"camoufox"}'}},
  {tool: "click_text", args: {text: "Search", within: "@dialog"}},
  {tool: "wait_for_change", args: {}}
])
```

**Search through an engine you control** (self-hosted SearXNG, or Brave/Tavily/Exa with a key).

```
search(query="firefox tls fingerprint", endpoint="http://127.0.0.1:8899")
scrape_markdown(url="<a url from the results>")
```


## How It Works

```
AI Agent (Claude, Cursor, Windsurf, VS Code)
    |
    |  MCP Protocol (stdio JSON-RPC)
    v
mcp-camoufox (Node.js)
    |
    |  Playwright API (Juggler protocol, NOT CDP)
    v
Camoufox (Patched Firefox binary)
    |
    |  C++ anti-fingerprint patches
    v
Website (Cloudflare, bot detection — bypassed)
```

### Why stealth works

- **Juggler protocol** instead of CDP — sites detecting Chrome DevTools Protocol cannot detect Camoufox
- **C++ level patches** — fingerprint spoofing at browser engine level, not JavaScript injection
- **GeoIP auto-detection** — timezone, locale, geolocation match your real IP
- **Human-like behavior** — optional `humanize` mode for realistic mouse movements

### Why sessions persist

Browser profile stored at `~/.camoufox-mcp/profile/`. Cookies, localStorage, IndexedDB survive across sessions. Login once, stay logged in.

### Why refs work better

`browser_snapshot` tags elements with `data-mcp-ref` attributes. This is:

- More **token-efficient** than sending full HTML
- More **reliable** than CSS selectors that break when sites update
- **Clickable** via `click(ref="e5")` — no selector gymnastics

## Data Storage


| Path                           | Contents                                       |
| ------------------------------ | ---------------------------------------------- |
| `~/.camoufox-mcp/profile/`     | Browser profile (cookies, localStorage, cache) |
| `~/.camoufox-mcp/screenshots/` | Screenshots, PDFs, HAR exports                 |


Reset everything: `rm -rf ~/.camoufox-mcp/` — or call the `reset_profile` tool (browser must be closed first).

### Switching between accounts on the same domain

The default profile persists across `browser_close` calls, so the next login on the same domain inherits cookies + session — sometimes redirecting to the wrong account. Two options:

- `**browser_launch(fresh_profile=true)**` — uses a temp profile dir that's removed on `browser_close`. Best for one-off logins.
- `**reset_profile**` (browser must be closed) — wipes the shared profile entirely.

## Troubleshooting


| Problem                                             | Fix                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Browser not running"                               | Call `browser_launch` first                                                                                                                                                                                                                                                                  |
| Click blocked by overlay                            | A synthetic pointer-event fallback fires and the response warns you (`⚠`). If the widget still ignores it, dismiss the blocker (`press_key("Escape")`) or use `mouse_click_xy`.                                                                                                              |
| Clicked the wrong "Cancel"/"Save"                   | `click_text` now fails with a candidate list instead of guessing. Use `within="@dialog"` to stay inside the open modal, or `index=N`.                                                                                                                                                        |
| Click on a Radix/Headless UI/MUI option did nothing | The real click was blocked and the old fallback used a bare `el.click()`, which those libraries ignore. Fixed — the fallback now replays the full pointer sequence. Upgrade if you're on ≤0.7.2.                                                                                             |
| Login gone after `browser_close`                    | `cookie_set` without `expires_days` creates a session cookie, which no browser writes to disk. Pass `expires_days=30`, or use `storage_state_save`/`auth_capture`. `browser_close` now tells you how many cookies were dropped.                                                              |
| Stale refs after navigation                         | Call `browser_snapshot` again — refs regenerate each time                                                                                                                                                                                                                                    |
| Window too large                                    | `browser_launch(width=1024, height=768)`                                                                                                                                                                                                                                                     |
| Viewport smaller than the window (~80px)            | That gap is browser chrome, not a bug. `set_viewport_size(w,h)` sets the exact viewport; `browser_launch(no_viewport=true)` lets the content fill the real window — but then the viewport can exceed the spoofed screen, which is an anti-bot tell (the launch reply warns when it happens). |
| First launch slow                                   | Downloading Camoufox binary (~80MB). Happens once.                                                                                                                                                                                                                                           |
| Huge snapshot output                                | Normal for big pages. Use `get_text` or `evaluate` instead.                                                                                                                                                                                                                                  |
| iframe not accessible                               | Use `list_frames` + `frame_evaluate`                                                                                                                                                                                                                                                         |
| CAPTCHA appears                                     | Cannot auto-solve. Use `headless=false` and solve manually.                                                                                                                                                                                                                                  |
| Login lands on wrong account                        | Profile carry-over. Use `fresh_profile=true` on launch or `reset_profile`.                                                                                                                                                                                                                   |
| Need a PDF                                          | `save_pdf` can't work on Firefox/Camoufox. Use `screenshot(full_page=true)`.                                                                                                                                                                                                                 |
| `browser_launch` fails with `Browser.setDefaultViewport ... isMobile` | You're on mcp-camoufox <0.9.3, which let npm resolve playwright-core 1.62.x. Upgrade to 0.9.3+ — it pins `playwright-core <1.61.0`. |
| `npm audit` flags adm-zip in your project | It comes from `camoufox-js`, which pins `adm-zip ^0.5.16`. Our own overrides can't reach your tree (npm applies overrides only from the root project), so add `"overrides": { "adm-zip": "0.6.0" }` to YOUR package.json if your scanner requires it. |
| Field value looks concatenated                      | Fixed — `fill`/`fill_form`/`batch_actions`/`login_classic` now clear `email`/`number` inputs before typing. Upgrade if you're on ≤0.7.2.                                                                                                                                                     |
| `humanize_click` did nothing                        | Fixed — it now scrolls the element into view and errors if the element is outside the viewport.                                                                                                                                                                                              |
| `navigate`, `tab_new` or `reload` hangs ~30s and times out | Camoufox stops delivering the `load`/`domcontentloaded` events after the **5th page** in a context, so every navigation waited out its full timeout on a page that had in fact loaded. Opening five tabs broke navigation for the rest of the session. Fixed in 0.9.11 — navigation now commits and polls `document.readyState` instead. Upgrade if you're on ≤0.9.10. |
| A tab opened after `dialog_handle` froze on a `confirm()` | The one-shot handler armed only the tabs that were open at the time, but told the persistent handler to stand down globally — so the dialog reached no handler, and a registered listener suppresses Playwright's auto-dismiss. Fixed in 0.9.11: tabs opened later are armed too. |
| MCP server silently dies                            | If you ran `pkill -f camoufox`, you killed the MCP node process too (its argv contains "camoufox"). Target the binary specifically — e.g. `pkill -f "Camoufox.app/Contents/MacOS"` — or use `pkill -f camoufox-js`.                                                                          |


## License

MIT
