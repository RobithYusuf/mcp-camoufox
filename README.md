<div align="center">

<img src="https://i.imgur.com/enUBkXt.png" alt="Camoufox" width="280">

# MCP Camoufox

[![npm version](https://img.shields.io/npm/v/mcp-camoufox.svg)](https://www.npmjs.com/package/mcp-camoufox)
[![npm downloads](https://img.shields.io/npm/dm/mcp-camoufox.svg)](https://www.npmjs.com/package/mcp-camoufox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)

</div>

The most feature-rich stealth browser MCP server. **69 tools** for full browser control powered by [Camoufox](https://github.com/daijro/camoufox) — a Firefox fork with C++ level anti-detection that bypasses Cloudflare, bot detection, and anti-automation.

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

| MCP Server | Tools | Stealth | npx Install | Persistent Session |
|------------|-------|---------|-------------|--------------------|
| Chrome DevTools MCP | 30+ | No | Built-in | Yes |
| whit3rabbit/camoufox-mcp | 1 | Yes | Yes | No |
| redf0x1/camofox-mcp | 45 | Yes | No (clone) | Yes |
| Sekinal/camoufox-mcp | 49 | Yes | No (clone) | Yes |
| Playwright CLI | 60+ | No | Yes | Yes |
| **[mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox)** | **69** | **Yes** | **Yes** | **Yes** |

## Setup

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add camoufox -- npx -y mcp-camoufox@latest
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Add to config file:
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
</details>

<details>
<summary><b>Cursor</b></summary>

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
</details>

<details>
<summary><b>Windsurf</b></summary>

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
</details>

<details>
<summary><b>VS Code (Continue / Cline)</b></summary>

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
</details>

<details>
<summary><b>Factory (Droid)</b></summary>

Add to `~/.factory/mcp.json` (global) or `.factory/mcp.json` (project):

```json
{
  "mcpServers": {
    "camoufox": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-camoufox@latest"],
      "disabled": false
    }
  }
}
```

Or via CLI:
```bash
droid mcp add camoufox "npx -y mcp-camoufox@latest"
```
</details>

<details>
<summary><b>OpenCode</b></summary>

Add to `~/.config/opencode/opencode.json` (global) or `opencode.json` (project):

```json
{
  "mcp": {
    "camoufox": {
      "type": "local",
      "command": ["npx", "-y", "mcp-camoufox@latest"],
      "enabled": true
    }
  }
}
```

> Note: OpenCode uses `"type": "local"` (not `"stdio"`) and `command` as a single array.
</details>

<details>
<summary><b>Trae (ByteDance)</b></summary>

Add to `~/.trae/mcp.json` (global) or `.trae/mcp.json` (project):

```json
{
  "mcpServers": [
    {
      "name": "camoufox",
      "command": ["npx", "-y", "mcp-camoufox@latest"]
    }
  ]
}
```

> Note: Trae uses an **array** format for `mcpServers`, not an object.
</details>

<details>
<summary><b>Antigravity (Google)</b></summary>

Add to `~/.gemini/antigravity/mcp_config.json`:

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

Or via UI: Agent Panel > `...` > MCP Servers > Manage MCP Servers > View raw config.
</details>

### Requirements

| Requirement | Version | Check |
|-------------|---------|-------|
| **Node.js** | 18+ | `node --version` |

That's all. Camoufox browser binary (~80MB) downloads automatically on first launch.

## All 69 Tools

### Browser Lifecycle (2)

| Tool | Description |
|------|-------------|
| `browser_launch` | Launch stealth browser. Options: `url`, `headless`, `humanize`, `geoip`, `locale`, `width`, `height` |
| `browser_close` | Close browser. Cookies preserved in profile. |

### Navigation (4)

| Tool | Description |
|------|-------------|
| `navigate` | Go to URL. Options: `wait_until` (domcontentloaded/load/networkidle), `timeout` |
| `go_back` | Back in history |
| `go_forward` | Forward in history |
| `reload` | Reload page |

### DOM & Content (6)

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get interactive elements with ref IDs. **Call after every navigation.** |
| `screenshot` | Capture viewport or full page. Options: `name`, `full_page` |
| `get_text` | Text from page or selector (max 5000 chars) |
| `get_html` | HTML from page or selector (max 10000 chars) |
| `get_url` | Current URL + title |
| `save_pdf` | Export page as PDF |

### Element Interaction (9)

| Tool | Description |
|------|-------------|
| `click` | Click by ref ID. Auto JS-fallback for overlays. Options: `button`, `dblclick` |
| `click_text` | Click by visible text. Options: `exact` |
| `click_role` | Click by ARIA role + name |
| `hover` | Hover over element |
| `fill` | Fill input/textarea (clears first) |
| `select_option` | Select from dropdown |
| `check` / `uncheck` | Toggle checkbox/radio |
| `upload_file` | Upload file to input |

### Keyboard (2)

| Tool | Description |
|------|-------------|
| `type_text` | Type char by char. Options: `delay`. For OTP, masked inputs, date pickers. |
| `press_key` | Key or combo: `Enter`, `Escape`, `Tab`, `Control+a`, `Meta+c` |

### Mouse XY (3)

| Tool | Description |
|------|-------------|
| `mouse_click_xy` | Click at exact coordinates |
| `mouse_move` | Move cursor to coordinates |
| `drag_and_drop` | Drag between two elements |

### Wait (4)

| Tool | Description |
|------|-------------|
| `wait_for` | Wait for selector or text (visible/hidden/attached/detached) |
| `wait_for_navigation` | Wait for page load |
| `wait_for_url` | Wait for URL pattern match |
| `wait_for_response` | Wait for network response pattern |

### Tabs (4)

| Tool | Description |
|------|-------------|
| `tab_list` | List all tabs |
| `tab_new` | Open new tab |
| `tab_select` | Switch tab |
| `tab_close` | Close tab |

### Cookies (3)

| Tool | Description |
|------|-------------|
| `cookie_list` | List cookies. Options: `domain` filter |
| `cookie_set` | Set cookie |
| `cookie_delete` | Delete by name/domain. Empty = clear all. |

### Local Storage (3)

| Tool | Description |
|------|-------------|
| `localstorage_get` | Get all or specific key |
| `localstorage_set` | Set key-value |
| `localstorage_clear` | Clear all |

### Session Storage (2)

| Tool | Description |
|------|-------------|
| `sessionstorage_get` | Get all or specific key |
| `sessionstorage_set` | Set key-value |

### JavaScript (2)

| Tool | Description |
|------|-------------|
| `evaluate` | Run JS in page context |
| `inject_init_script` | Inject script that runs on every page load |

### Element Inspection (4)

| Tool | Description |
|------|-------------|
| `inspect_element` | Full element info: tag, attributes, box, styles |
| `get_attribute` | Get specific attribute |
| `query_selector_all` | Query multiple elements by CSS selector |
| `get_links` | Get all links with URL + text. Options: `filter` |

### Frames (2)

| Tool | Description |
|------|-------------|
| `list_frames` | List all frames/iframes |
| `frame_evaluate` | Run JS inside a frame |

### Batch Operations (3)

| Tool | Description |
|------|-------------|
| `batch_actions` | Multiple actions in one call (click, fill, type, press, wait) |
| `fill_form` | Fill multiple fields + optional submit |
| `navigate_and_snapshot` | Navigate + snapshot in one call |

### Viewport (2)

| Tool | Description |
|------|-------------|
| `get_viewport_size` | Get width x height |
| `set_viewport_size` | Set dimensions |

### Scroll (1)

| Tool | Description |
|------|-------------|
| `scroll` | Scroll up/down/left/right by pixel amount |

### Dialog (1)

| Tool | Description |
|------|-------------|
| `dialog_handle` | Pre-set accept/dismiss for next alert/confirm/prompt |

### Accessibility (1)

| Tool | Description |
|------|-------------|
| `accessibility_snapshot` | Accessibility tree for LLM understanding |

### Console & Network (4)

| Tool | Description |
|------|-------------|
| `console_start` / `console_get` | Capture and retrieve browser console messages |
| `network_start` / `network_get` | Capture and retrieve network requests |

### Scraping & Extraction (4)

| Tool | Description |
|------|-------------|
| `detect_content_pattern` | Auto-detect repeated content (cards, listings) and suggest CSS selectors. **Run this before `extract_structured`.** |
| `extract_structured` | Extract data from repeated elements as clean JSON. Auto-deduplicates, filters empties, `direct_text_only` prevents field mixing. |
| `extract_table` | Extract HTML table as JSON array with auto-detected headers |
| `scrape_page` | Smart scraper: auto-extract main content (strips nav/footer), links, meta, headings. Smart truncation at paragraph boundary. |

### Debug (3)

| Tool | Description |
|------|-------------|
| `server_status` | Health check: browser status, tabs, URL |
| `get_page_errors` | JS errors from page |
| `export_har` | Export network traffic as HAR file |

## Examples

### Login to a website

```
browser_launch(url="https://accounts.google.com", headless=false)
browser_snapshot()                              # see email input
fill(ref="e1", value="user@gmail.com")          # fill email
click(ref="e4")                                 # click Next
wait_for(selector='input[type="password"]')     # wait for password page
browser_snapshot()
fill(ref="e2", value="mypassword")              # fill password
click(ref="e4")                                 # click Next
```

### Fill a form in one call

```
fill_form(
  fields=[
    {ref: "e3", value: "John Doe"},
    {ref: "e5", value: "john@example.com"},
    {ref: "e7", value: "Hello world"}
  ],
  submit_ref="e10"
)
```

### Batch multiple actions

```
batch_actions(actions=[
  {type: "click", ref: "e5"},
  {type: "wait", timeout: 1000},
  {type: "fill", ref: "e8", value: "search query"},
  {type: "press", key: "Enter"}
])
```

### Search Google

```
browser_launch(url="https://google.com")
browser_snapshot()
click(ref="e5")                               # search box
type_text(text="mcp-camoufox npm")
press_key(key="Enter")
```

### Multi-tab research

```
browser_launch(url="https://github.com")
tab_new(url="https://stackoverflow.com")
tab_list()
tab_select(index=0)
```

### Wait for API response

```
click(ref="e10")
wait_for_response(url_pattern="/api/data")
browser_snapshot()
```

### Inspect elements

```
inspect_element(ref="e5")
get_links(filter="github.com")
query_selector_all(selector=".product-card")
```

### Work with iframes

```
list_frames()
frame_evaluate(frame_index=1, expression="document.title")
```

### Scrape job listings (structured)

```
browser_launch(url="https://glints.com/id/opportunities/jobs/explore")
detect_content_pattern()                      # auto-suggest selectors
extract_structured(
  container_selector=".job-card",             # from detect_content_pattern
  fields=[
    {name: "title", selector: "h3"},
    {name: "company", selector: ".company-name"},
    {name: "location", selector: ".location"},
    {name: "url", selector: "a", attribute: "href"}
  ]
)
```

### Scrape page content (smart)

```
scrape_page(only_main_content=true, max_text_length=8000)
# Returns: title, url, meta, text (truncated at paragraph boundary),
#          links, headings, truncated flag, total_text_length
```

### Manage storage

```
localstorage_get()
localstorage_set(key="token", value="abc123")
cookie_list(domain="example.com")
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

| Path | Contents |
|------|----------|
| `~/.camoufox-mcp/profile/` | Browser profile (cookies, localStorage, cache) |
| `~/.camoufox-mcp/screenshots/` | Screenshots, PDFs, HAR exports |

Reset everything: `rm -rf ~/.camoufox-mcp/`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Browser not running" | Call `browser_launch` first |
| Click blocked by overlay | Auto JS-fallback handles it. Or `press_key("Escape")` first. |
| Stale refs after navigation | Call `browser_snapshot` again — refs regenerate each time |
| Window too large | `browser_launch(width=1024, height=768)` |
| First launch slow | Downloading Camoufox binary (~80MB). Happens once. |
| Huge snapshot output | Normal for big pages. Use `get_text` or `evaluate` instead. |
| iframe not accessible | Use `list_frames` + `frame_evaluate` |
| CAPTCHA appears | Cannot auto-solve. Use `headless=false` and solve manually. |

## License

MIT

---

Built by [RobithYusuf](https://github.com/RobithYusuf)
