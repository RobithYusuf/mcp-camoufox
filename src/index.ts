#!/usr/bin/env node
/**
 * MCP Camoufox — stealth browser automation MCP server.
 *
 * MCP stdio tools: browser control (Camoufox/Firefox via Playwright's
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
import { shutdownBrowser, warmBrowserModules } from "./tools/browser.js";
import { stopDownload } from "./install.js";

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
  // Load the browser libraries once the handshake is over, so neither initialize nor
  // the first browser_launch waits for them. A failure here is reported by browser_launch.
  server.server.oninitialized = () => { setTimeout(() => { warmBrowserModules().catch(() => {}); }, 200).unref(); };
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-camoufox] Server running on stdio...");
}

// Leave nothing behind however the client goes away. A client that crashes only
// closes our stdin, and the browser's pipes then keep this process alive for ever
// with the browser still running. A signal used to exit at once and leave the temp
// profile on disk.
let exiting = false;
function exitCleanly() {
  if (exiting) return;
  exiting = true;
  // Never let a wedged browser keep the process alive.
  setTimeout(() => process.exit(0), 20000).unref();
  stopDownload();
  shutdownBrowser().catch(() => {}).finally(() => process.exit(0));
}
process.on("SIGINT", exitCleanly);
process.on("SIGTERM", exitCleanly);
process.on("SIGHUP", exitCleanly);
process.stdin.on("end", exitCleanly);
process.stdin.on("close", exitCleanly);

main().catch((err) => {
  console.error("[mcp-camoufox] Fatal:", err);
  process.exit(1);
});
