#!/usr/bin/env node
/**
 * MCP Camoufox — stealth browser automation MCP server.
 *
 * 127 tools over MCP stdio: browser control (Camoufox/Firefox via Playwright's
 * Juggler) plus a browserless HTTP path that presents the same Firefox TLS
 * fingerprint, so routine fetching never has to pay for a browser launch.
 *
 * Layout
 *   state.ts     the single mutable runtime record + page bookkeeping
 *   helpers.ts   refs, clicks, fills, snapshots, paths, TOTP
 *   server.ts    the McpServer instance and the regTool registry
 *   tools/*.ts   the tools themselves, grouped by area
 *
 * Install:  npx -y mcp-camoufox@latest
 * Usage:    claude mcp add camoufox -- npx -y mcp-camoufox@latest
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";

// Each tool module registers itself on import. Import order only affects the
// order tools appear in tools/list, never their behaviour.
import "./tools/browser.js";
import "./tools/input.js";
import "./tools/tabs.js";
import "./tools/capture.js";
import "./tools/inspect.js";
import "./tools/extract.js";
import "./tools/session.js";
import "./tools/http.js";
import "./tools/ergonomics.js";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-camoufox] Server running on stdio...");
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err) => {
  console.error("[mcp-camoufox] Fatal:", err);
  process.exit(1);
});
