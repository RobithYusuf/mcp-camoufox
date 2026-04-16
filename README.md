# MCP Camoufox

[![npm version](https://img.shields.io/npm/v/mcp-camoufox.svg)](https://www.npmjs.com/package/mcp-camoufox)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server for **stealth browser automation** via [Camoufox](https://github.com/daijro/camoufox) — a privacy-focused Firefox fork with C++ level anti-detection patches.

**Chrome DevTools MCP-level power, with anti-bot stealth.**

## Why?

| Tool | Browser Control | Stealth | Persistent Session | Install |
|------|----------------|---------|--------------------|---------| 
| Chrome DevTools MCP | 30+ tools | No | Yes | Built-in |
| whit3rabbit/camoufox-mcp | 1 tool | Yes | No | npx |
| Playwright CLI | 60+ commands | No | Yes | npx |
| **mcp-camoufox** | **39 tools** | **Yes** | **Yes** | **npx** |

## Quick Start

### Claude Code

```bash
claude mcp add camoufox -- npx -y mcp-camoufox@latest
```

That's it. No pip, no Python, no manual downloads.

### Claude Desktop

Add to your config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`

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

That's all. No Python, no pip, no manual binary downloads. Camoufox browser is downloaded automatically on first launch (~80MB, once).

## Features

- **39 MCP tools** for full browser control
- **Camoufox stealth** — C++ fingerprint patches at browser engine level, bypasses Cloudflare Turnstile and bot detection
- **Persistent session** — browser stays alive between tool calls, cookies and state maintained across sessions
- **JS click fallback** — automatically falls back to JavaScript click when elements are blocked by overlays
- **1280x800 default window** — fits any screen without cropping, customizable via width/height params
- **Ref-based interaction** — `browser_snapshot` returns compact element list with ref IDs, not raw HTML (token-efficient)

## Tools (39)

### Browser Lifecycle

| Tool | Description |
|------|-------------|
| `browser_launch` | Launch Camoufox and navigate to URL. Options: `url`, `headless`, `humanize`, `geoip`, `locale`, `width`, `height` |
| `browser_close` | Close browser. Cookies are preserved in persistent profile. |

### Navigation

| Tool | Description |
|------|-------------|
| `navigate` | Go to URL with configurable wait strategy (`domcontentloaded`, `load`, `networkidle`) and timeout |
| `go_back` | Navigate back in browser history |
| `go_forward` | Navigate forward in browser history |
| `reload` | Reload current page |

### DOM & Page Content

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get all visible interactive elements with ref IDs. Use these refs with `click`, `fill`, etc. **Always call after navigation.** |
| `screenshot` | Capture viewport or full-page screenshot. Saved to `~/.camoufox-mcp/screenshots/` |
| `get_text` | Get visible text from page or CSS selector (truncated at 5000 chars) |
| `get_html` | Get inner/outer HTML from page or CSS selector (truncated at 10000 chars) |
| `get_url` | Get current URL and page title |
| `save_pdf` | Export current page as PDF |

### Element Interaction

| Tool | Description |
|------|-------------|
| `click` | Click element by ref ID. Auto JS-fallback for overlays. Options: `button` (left/right/middle), `dblclick` |
| `click_text` | Click element by visible text. Options: `exact` (true/false) |
| `click_role` | Click element by ARIA role and accessible name (e.g. role=`button`, name=`Submit`) |
| `hover` | Hover over element by ref ID |
| `fill` | Fill input/textarea by ref ID. Clears existing content first. |
| `select_option` | Select option from `<select>` dropdown by ref ID |
| `check` | Check a checkbox or radio button by ref ID |
| `uncheck` | Uncheck a checkbox by ref ID |
| `upload_file` | Upload file to a file input by ref ID |

### Keyboard

| Tool | Description |
|------|-------------|
| `type_text` | Type text character by character via keyboard. Options: `delay` (ms between keys). Use for masked inputs that don't support `fill`. |
| `press_key` | Press key or combination: `Enter`, `Escape`, `Tab`, `ArrowDown`, `Control+a`, `Meta+c`, `Shift+Tab` |

### Wait

| Tool | Description |
|------|-------------|
| `wait_for` | Wait for CSS selector or text to become visible/hidden/attached/detached. Options: `state`, `timeout` |
| `wait_for_navigation` | Wait for page load to complete |

### Tab Management

| Tool | Description |
|------|-------------|
| `tab_list` | List all open tabs with URLs and titles |
| `tab_new` | Open new tab, optionally navigate to URL |
| `tab_select` | Switch active tab by index |
| `tab_close` | Close tab by index (default: active tab) |

### Cookies

| Tool | Description |
|------|-------------|
| `cookie_list` | List all cookies, optionally filter by domain |
| `cookie_set` | Set a cookie (name, value, domain, path) |
| `cookie_delete` | Delete cookies by name/domain, or clear all |

### JavaScript

| Tool | Description |
|------|-------------|
| `evaluate` | Execute JavaScript in page context and return result |

### Scroll

| Tool | Description |
|------|-------------|
| `scroll` | Scroll page in any direction: `up`, `down`, `left`, `right` with configurable `amount` in pixels |

### Dialog

| Tool | Description |
|------|-------------|
| `dialog_handle` | Pre-set handler for next alert/confirm/prompt dialog: `accept` or `dismiss` |

### Debug

| Tool | Description |
|------|-------------|
| `console_start` | Start capturing browser console messages |
| `console_get` | Retrieve captured console messages (last 50) |
| `network_start` | Start capturing network requests/responses |
| `network_get` | Retrieve captured network requests (last 50) |

## Usage Examples

### Basic: Open site and interact

```
browser_launch(url="https://example.com", headless=false)
browser_snapshot()          # see all interactive elements
click(ref="e5")             # click an element
fill(ref="e12", value="hello@example.com")
click_role(role="button", name="Submit")
screenshot()                # see the result
browser_close()             # done, cookies saved
```

### Login flow

```
browser_launch(url="https://site.com/login")
browser_snapshot()
fill(ref="e3", value="user@email.com")      # email
click(ref="e5")                               # Continue
wait_for(selector='input[type="password"]')
browser_snapshot()
fill(ref="e2", value="mypassword")            # password
click(ref="e4")                               # Sign in
wait_for_navigation()
browser_snapshot()                            # verify logged in
```

### Multi-tab research

```
browser_launch(url="https://github.com")
tab_new(url="https://stackoverflow.com")
tab_list()                                    # see both tabs
tab_select(index=0)                           # switch to GitHub
```

### Search with keyboard

```
browser_launch(url="https://google.com")
browser_snapshot()
click(ref="e5")                               # click search box
type_text(text="mcp-camoufox npm")
press_key(key="Enter")
```

## How It Works

```
AI Agent (Claude, Cursor, etc.)
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

**Why Juggler, not CDP?** Camoufox is Firefox-based. It communicates via Playwright's Juggler protocol, completely avoiding Chrome DevTools Protocol. Sites that detect CDP automation (like ChatGPT, Cloudflare-protected sites) cannot detect Camoufox.

**Why persistent context?** Browser profile is stored at `~/.camoufox-mcp/profile/`. Cookies, localStorage, and IndexedDB survive across sessions. Login once, stay logged in.

**Why ref-based?** `browser_snapshot` tags visible elements with `data-mcp-ref` attributes and returns a compact list. This is more token-efficient than sending full HTML and more reliable than CSS selectors that break when sites update.

## Persistent Data

| Path | Purpose |
|------|---------|
| `~/.camoufox-mcp/profile/` | Browser profile (cookies, localStorage, cache) |
| `~/.camoufox-mcp/screenshots/` | Screenshots and PDFs |

To reset (clear all cookies and sessions):
```bash
rm -rf ~/.camoufox-mcp/profile/
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Browser not running" | Call `browser_launch` first before any other tool |
| Click fails / element intercepted | Tool auto-fallbacks to JS click. If still fails, `browser_snapshot` to check refs |
| Window too large for screen | Use `browser_launch(width=1024, height=768)` |
| First launch slow (~30s) | Camoufox downloading browser binary. Only happens once. |
| Stale ref IDs | Call `browser_snapshot` again after navigation — refs regenerate each time |
| Snapshot too large (Wikipedia etc.) | Normal for element-heavy pages. Use `get_text` or `evaluate` instead. |

## License

MIT
