// The MCP server instance plus the registration wrapper every tool goes through.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PKG_VERSION } from "./helpers.js";


export const server = new McpServer({
  name: "camoufox-browser",
  version: PKG_VERSION,
});

// Every tool registers through here so workflow_run can invoke tools by name.
// Same signature as server.tool(name, description, schema, handler) — the schema
// is kept so a workflow step gets the same zod validation + defaults a real MCP
// call would get, instead of handlers seeing undefined for omitted params.
export const toolRegistry = new Map<string, { schema: any; handler: Function }>();
// Typed as server.tool itself so every handler keeps its inferred argument types.
export const regTool: typeof server.tool = ((name: any, description: any, schema: any, handler: any) => {
  toolRegistry.set(name, { schema, handler });
  return (server as any).tool(name, description, schema, handler);
}) as any;
