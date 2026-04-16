# MCP Camoufox

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
claude mcp add camoufox -- npx -y mcp-camoufox
```

Done. That's it.

### Claude Desktop

Add to config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "camoufox": {
      "command": "npx",
      "args": ["-y", "mcp-camoufox"]
    }
  }
}
```

### Cursor

```json
{
  "mcp": {
    "servers": {
      "camoufox": {
        "command": "npx",
        "args": ["-y", "mcp-camoufox"]
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
      "args": ["-y", "mcp-camoufox"]
    }
  }
}
```

## Requirements

- **Node.js 18+** (`node --version`)
- Camoufox browser binary is downloaded automatically on first launch

No Python required. No manual setup.

## Features

- **39 MCP tools** for full browser control
- **Camoufox stealth** — C++ fingerprint patches, bypasses Cloudflare Turnstile
- **Persistent session** — browser stays alive between calls, cookies maintained
- **JS click fallback** — auto-fallback when elements blocked by overlays
- **1280x800 default** — fits any screen, no cropping

## Tools (39)

### Browser Lifecycle
| Tool | Description |
|------|-------------|
| `browser_launch` | Launch browser. Options: url, headless, humanize, geoip, locale, width, height |
| `browser_close` | Close browser (cookies saved) |

### Navigation
| Tool | Description |
|------|-------------|
| `navigate` | Go to URL (wait strategy + timeout) |
| `go_back` / `go_forward` / `reload` | History navigation |

### DOM & Content
| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get interactive elements with ref IDs |
| `screenshot` | Capture page (viewport or full page) |
| `get_text` / `get_html` / `get_url` | Read page content |
| `save_pdf` | Export as PDF |

### Interaction
| Tool | Description |
|------|-------------|
| `click` | Click by ref ID (JS fallback for overlays) |
| `click_text` | Click by visible text |
| `click_role` | Click by ARIA role + name |
| `hover` / `fill` / `select_option` | Hover, fill input, select dropdown |
| `check` / `uncheck` | Checkbox/radio |
| `upload_file` | File upload |

### Keyboard
| Tool | Description |
|------|-------------|
| `type_text` | Type char by char |
| `press_key` | Key or combo (Enter, Escape, Control+a) |

### Wait
| Tool | Description |
|------|-------------|
| `wait_for` | Wait for selector/text (visible/hidden) |
| `wait_for_navigation` | Wait for page load |

### Tabs
| Tool | Description |
|------|-------------|
| `tab_list` / `tab_new` / `tab_select` / `tab_close` | Multi-tab |

### Cookies
| Tool | Description |
|------|-------------|
| `cookie_list` / `cookie_set` / `cookie_delete` | Cookie management |

### Other
| Tool | Description |
|------|-------------|
| `evaluate` | Execute JavaScript |
| `scroll` | Scroll page (up/down/left/right) |
| `dialog_handle` | Accept/dismiss alerts |
| `console_start` / `console_get` | Capture console |
| `network_start` / `network_get` | Capture network |

## Usage Flow

```
1. browser_launch(url="https://example.com", headless=false)
2. browser_snapshot()          → see interactive elements with ref IDs
3. click(ref="e5")             → click element
4. fill(ref="e12", value="hello@example.com")
5. click_role(role="button", name="Submit")
6. screenshot()                → see result
7. browser_close()             → cookies saved
```

## How It Works

```
AI Agent (Claude, Cursor, etc.)
    ↓ MCP Protocol (stdio)
mcp-camoufox (Node.js)
    ↓ Playwright API (Juggler protocol, NOT CDP)
Camoufox (Patched Firefox)
    ↓ C++ anti-fingerprint patches
Website (Cloudflare bypassed)
```

- **Juggler protocol** (not CDP) — no Chrome DevTools Protocol detection
- **Persistent profile** at `~/.camoufox-mcp/profile/` — cookies survive sessions
- **Screenshots** at `~/.camoufox-mcp/screenshots/`
- **Ref-based** interaction via `data-mcp-ref` attributes from `browser_snapshot`

## Persistent Data

| Path | Purpose |
|------|---------|
| `~/.camoufox-mcp/profile/` | Browser profile (cookies, localStorage) |
| `~/.camoufox-mcp/screenshots/` | Screenshots and PDFs |

Reset: `rm -rf ~/.camoufox-mcp/profile/`

## Troubleshooting

**"Browser not running"** — Call `browser_launch` first.

**Click fails** — Tool auto-fallbacks to JS click. If still fails, use `browser_snapshot` to check refs.

**Window too large** — Use `browser_launch(width=1024, height=768)`.

**First launch slow** — Camoufox downloads browser binary (~80MB, once).

## License

MIT
