# MCP Camoufox

[![npm version](https://img.shields.io/npm/v/mcp-camoufox.svg)](https://www.npmjs.com/package/mcp-camoufox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server for **stealth browser automation** via [Camoufox](https://github.com/daijro/camoufox) — a privacy-focused Firefox fork with C++ level anti-detection patches.

**65 tools. Chrome DevTools MCP-level power. Anti-bot stealth. One command install.**

## Why?

| Tool | Tools | Stealth | npx Install | Persistent Session |
|------|-------|---------|-------------|--------------------|
| Chrome DevTools MCP | 30+ | No | Built-in | Yes |
| whit3rabbit/camoufox-mcp | 1 | Yes | Yes | No |
| redf0x1/camofox-mcp | 45 | Yes | No (clone) | Yes |
| Sekinal/camoufox-mcp | 49 | Yes | No (clone) | Yes |
| Playwright CLI | 60+ | No | Yes | Yes |
| **[mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox)** | **65** | **Yes** | **Yes** | **Yes** |

## Quick Start

### Claude Code

```bash
claude mcp add camoufox -- npx -y mcp-camoufox@latest
```

That's it. No pip, no Python, no manual downloads.

### Claude Desktop

Add to your config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

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

### Cursor

Preferences > Features > MCP:

```json
{
  "mcp": {
    "servers": {
      "camoufox": {
        "command": "npx",
        "args": ["-y", "mcp-camoufox@latest"]
      }
    }
  }
}
```

### Windsurf

Add to `~/.windsurf/mcp.json`:

```json
{
  "servers": {
    "camoufox": {
      "command": "npx",
      "args": ["-y", "mcp-camoufox@latest"]
    }
  }
}
```

### VS Code (Continue / Cline)

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

## Requirements

| Requirement | Version | How to check |
|-------------|---------|--------------|
| **Node.js** | 18+ | `node --version` |

That's all. Camoufox browser binary is downloaded automatically on first launch (~80MB, once).

## All 65 Tools

### Browser Lifecycle (2)

| Tool | Description |
|------|-------------|
| `browser_launch` | Launch Camoufox stealth browser and navigate to URL. Browser persists between calls — cookies and sessions maintained. Options: `url`, `headless` (true/false), `humanize` (human-like mouse), `geoip` (auto timezone), `locale`, `width`, `height` |
| `browser_close` | Close browser gracefully. Cookies and localStorage are preserved in persistent profile at `~/.camoufox-mcp/profile/` |

### Navigation (4)

| Tool | Description |
|------|-------------|
| `navigate` | Go to URL with configurable wait strategy (`domcontentloaded`, `load`, `networkidle`) and timeout in ms |
| `go_back` | Navigate back in browser history |
| `go_forward` | Navigate forward in browser history |
| `reload` | Reload current page |

### DOM Snapshot & Page Content (6)

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get all visible interactive elements with ref IDs. Returns compact list — use ref IDs with `click`, `fill`, etc. **Always call after navigation to get fresh refs.** |
| `screenshot` | Capture viewport or full-page screenshot. Saved to `~/.camoufox-mcp/screenshots/`. Options: `name` (filename prefix), `full_page` |
| `get_text` | Get visible text from page or specific CSS selector. Truncated at 5000 chars for token efficiency. |
| `get_html` | Get inner or outer HTML from page or CSS selector. Truncated at 10000 chars. Options: `selector`, `outer` |
| `get_url` | Get current page URL and title |
| `save_pdf` | Export current page as PDF file |

### Element Interaction (9)

| Tool | Description |
|------|-------------|
| `click` | Click element by ref ID from `browser_snapshot`. Auto JS-fallback when element is blocked by overlay. Options: `button` (left/right/middle), `dblclick` |
| `click_text` | Click element by its visible text content. Options: `exact` (true = exact match, false = partial) |
| `click_role` | Click element by ARIA role and accessible name (e.g. role=`button`, name=`Submit`) |
| `hover` | Hover over element by ref ID — triggers hover effects, tooltips, dropdown menus |
| `fill` | Fill text into input or textarea by ref ID. Clears existing content first. Works for standard form inputs. |
| `select_option` | Select option from `<select>` dropdown by ref ID and option value/label |
| `check` | Check a checkbox or radio button by ref ID |
| `uncheck` | Uncheck a checkbox by ref ID |
| `upload_file` | Upload file to a file input element by ref ID. Takes absolute file path. |

### Keyboard (2)

| Tool | Description |
|------|-------------|
| `type_text` | Type text character by character via keyboard. Options: `delay` (ms between keys). Use for masked inputs, OTP fields, date pickers — anything that doesn't support `fill`. |
| `press_key` | Press keyboard key or combination. Examples: `Enter`, `Escape`, `Tab`, `ArrowDown`, `Control+a`, `Meta+c`, `Shift+Tab`, `F5` |

### Mouse XY (3)

| Tool | Description |
|------|-------------|
| `mouse_click_xy` | Click at exact x,y pixel coordinates on the page. Options: `button` (left/right/middle). Use when ref-based click isn't possible. |
| `mouse_move` | Move mouse cursor to exact x,y coordinates. Use for triggering hover effects at specific positions. |
| `drag_and_drop` | Drag element from one position to another by ref IDs. Use for sortable lists, kanban boards, file drop zones. |

### Wait (4)

| Tool | Description |
|------|-------------|
| `wait_for` | Wait for CSS selector or text to become visible/hidden/attached/detached. Options: `selector`, `text`, `state`, `timeout` |
| `wait_for_navigation` | Wait for page load to complete after a click or form submission |
| `wait_for_url` | Wait for URL to match a substring or regex pattern. Use after actions that trigger redirects. |
| `wait_for_response` | Wait for a specific network response matching a URL pattern. Use to wait for API calls to complete. |

### Tab Management (4)

| Tool | Description |
|------|-------------|
| `tab_list` | List all open tabs with index, URL, title, and active status |
| `tab_new` | Open new tab, optionally navigate to URL. New tab becomes active. |
| `tab_select` | Switch active tab by index from `tab_list` |
| `tab_close` | Close tab by index. Default: close active tab. |

### Cookies (3)

| Tool | Description |
|------|-------------|
| `cookie_list` | List all cookies, optionally filter by domain. Shows name, value (truncated), domain. |
| `cookie_set` | Set a cookie with name, value, domain, and path |
| `cookie_delete` | Delete cookies by name and/or domain. Both empty = clear ALL cookies. |

### Local Storage (3)

| Tool | Description |
|------|-------------|
| `localstorage_get` | Get all localStorage data or a specific key. Returns JSON for all, or value for specific key. |
| `localstorage_set` | Set a localStorage key-value pair |
| `localstorage_clear` | Clear all localStorage data |

### Session Storage (2)

| Tool | Description |
|------|-------------|
| `sessionstorage_get` | Get all sessionStorage data or a specific key |
| `sessionstorage_set` | Set a sessionStorage key-value pair |

### JavaScript (2)

| Tool | Description |
|------|-------------|
| `evaluate` | Execute JavaScript in page context and return result. Supports expressions and IIFE functions. |
| `inject_init_script` | Inject a script that runs automatically before every page load. Use for modifying page behavior, intercepting requests, etc. |

### Element Inspection (4)

| Tool | Description |
|------|-------------|
| `inspect_element` | Get detailed info about an element: tag, id, class, all attributes, bounding box, computed styles (font size, color, background), text content, value |
| `get_attribute` | Get a specific attribute value from an element by ref ID |
| `query_selector_all` | Query multiple elements by CSS selector. Returns text, tag, and optional attribute for all matches. Options: `limit` |
| `get_links` | Get all hyperlinks on the page with URL and text. Options: `filter` (URL pattern to match) |

### Frames / Iframes (2)

| Tool | Description |
|------|-------------|
| `list_frames` | List all frames and iframes in the page with index, name, and URL |
| `frame_evaluate` | Execute JavaScript inside a specific frame/iframe by name or index. Use for interacting with embedded content. |

### Batch Operations (3)

| Tool | Description |
|------|-------------|
| `batch_actions` | Execute multiple actions in one call. Each action: `{type, ref?, value?, text?, key?, timeout?}`. Types: click, fill, type, press, select, check, uncheck, wait. Reduces round-trips significantly. |
| `fill_form` | Fill multiple form fields at once and optionally click submit. Takes array of `{ref, value}` pairs + optional `submit_ref`. |
| `navigate_and_snapshot` | Navigate to URL then return element snapshot — two operations in one call. Saves a round-trip. |

### Viewport (2)

| Tool | Description |
|------|-------------|
| `get_viewport_size` | Get current viewport width and height in pixels |
| `set_viewport_size` | Set viewport dimensions. Use for testing responsive layouts. |

### Scroll (1)

| Tool | Description |
|------|-------------|
| `scroll` | Scroll page in any direction: `up`, `down`, `left`, `right` with configurable `amount` in pixels |

### Dialog (1)

| Tool | Description |
|------|-------------|
| `dialog_handle` | Pre-set handler for the next browser dialog (alert/confirm/prompt). Options: `accept` or `dismiss`, with optional `prompt_text` for prompt dialogs. Must be called BEFORE the action that triggers the dialog. |

### Accessibility (1)

| Tool | Description |
|------|-------------|
| `accessibility_snapshot` | Get accessibility tree snapshot — compact hierarchical view of page structure with roles and names. Useful for LLM understanding of complex pages. |

### Console & Network Capture (4)

| Tool | Description |
|------|-------------|
| `console_start` | Start capturing browser console messages (log, warn, error, info) |
| `console_get` | Retrieve captured console messages since `console_start`. Shows last 50 messages with type and text. |
| `network_start` | Start capturing network requests and responses |
| `network_get` | Retrieve captured network requests since `network_start`. Shows last 50 with method, status, URL. |

### Debug & Health (3)

| Tool | Description |
|------|-------------|
| `server_status` | Health check — shows browser status, active tab count, current URL, profile directory |
| `get_page_errors` | Get JavaScript errors from the current page |
| `export_har` | Export captured network traffic as HAR (HTTP Archive) file for analysis in browser dev tools |

## Usage Examples

### Basic: Open and interact

```
browser_launch(url="https://example.com", headless=false)
browser_snapshot()
click(ref="e5")
fill(ref="e12", value="hello@example.com")
screenshot()
browser_close()
```

### Login flow

```
browser_launch(url="https://site.com/login")
browser_snapshot()
fill(ref="e3", value="user@email.com")
click(ref="e5")                               # Continue
wait_for(selector='input[type="password"]')
browser_snapshot()
fill(ref="e2", value="mypassword")
click(ref="e4")                               # Sign in
wait_for_navigation()
browser_snapshot()                            # verify logged in
```

### Fill form in one call

```
browser_snapshot()
fill_form(
  fields=[
    {ref: "e3", value: "John Doe"},
    {ref: "e5", value: "john@example.com"},
    {ref: "e7", value: "Hello world"}
  ],
  submit_ref="e10"
)
```

### Batch actions (reduce round-trips)

```
batch_actions(actions=[
  {type: "click", ref: "e5"},
  {type: "wait", timeout: 1000},
  {type: "fill", ref: "e8", value: "search query"},
  {type: "press", key: "Enter"}
])
```

### Multi-tab research

```
browser_launch(url="https://github.com")
tab_new(url="https://stackoverflow.com")
tab_list()
tab_select(index=0)                           # switch to GitHub
```

### Search with keyboard

```
browser_launch(url="https://google.com")
browser_snapshot()
click(ref="e5")
type_text(text="mcp-camoufox npm")
press_key(key="Enter")
```

### Wait for API response

```
click(ref="e10")                              # trigger action
wait_for_response(url_pattern="/api/data")    # wait for API call
browser_snapshot()                            # see updated page
```

### Inspect and debug

```
inspect_element(ref="e5")                     # detailed element info
get_links(filter="github.com")                # all GitHub links
query_selector_all(selector=".product-card")  # all matching elements
```

### Work with iframes

```
list_frames()
frame_evaluate(frame_index=1, expression="document.title")
```

### Manage storage

```
localstorage_get()                            # dump all localStorage
localstorage_set(key="token", value="abc123")
cookie_list(domain="example.com")
```

## Architecture

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

**Juggler, not CDP** — Camoufox is Firefox-based. Sites that detect Chrome DevTools Protocol automation cannot detect Camoufox.

**Persistent profile** — Browser state stored at `~/.camoufox-mcp/profile/`. Cookies, localStorage, IndexedDB survive across sessions.

**Ref-based interaction** — `browser_snapshot` tags elements with `data-mcp-ref` attributes. More token-efficient than raw HTML, more reliable than CSS selectors.

**JS click fallback** — When Playwright's actionability checks fail (element behind overlay), automatically falls back to `element.click()` via JavaScript.

## Persistent Data

| Path | Purpose |
|------|---------|
| `~/.camoufox-mcp/profile/` | Browser profile (cookies, localStorage, cache) |
| `~/.camoufox-mcp/screenshots/` | Screenshots, PDFs, HAR exports |

Reset all data: `rm -rf ~/.camoufox-mcp/`

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Browser not running" | Call `browser_launch` first |
| Click fails / element intercepted | Auto JS-fallback handles most cases. Try `press_key("Escape")` to dismiss overlays, then `browser_snapshot` |
| Stale ref IDs | Refs regenerate on each `browser_snapshot` call. Always snapshot after navigation. |
| Window too large | `browser_launch(width=1024, height=768)` |
| First launch slow (~30s) | Camoufox downloading browser binary. Only happens once. |
| Snapshot too large | Normal for element-heavy pages (Wikipedia). Use `get_text` or `evaluate` instead. |
| iframe content not accessible | Use `list_frames` + `frame_evaluate` to interact with iframe content |

## License

MIT
