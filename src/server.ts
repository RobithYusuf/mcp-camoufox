// The MCP server instance plus the registration wrapper every tool goes through.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PKG_VERSION } from "./helpers.js";
import { scrubErrorText } from "./redact.js";
import { dialogLog } from "./state.js";


export const server = new McpServer({
  name: "camoufox-browser",
  version: PKG_VERSION,
});

// How long a tool may run before it answers anyway. page.evaluate has no timeout, so
// a wedged tab or a promise that never settles otherwise holds the call open until the
// client gives up, and the caller learns nothing. 50s stays under the 60s most MCP
// clients allow. A call asking for a longer wait gets that wait plus a margin.
const DEADLINE_MS = Number(process.env.MCP_CAMOUFOX_TOOL_DEADLINE_MS) || 50000;
const WAIT_ARGS = ["timeout", "timeout_ms", "duration_ms", "wait_ms", "step_timeout_ms"];
// Their running time is the sum of work the caller chose, or a first-run download.
const LONG_RUNNING = new Set(["browser_launch", "chatgpt_generate_image", "chatgpt_generate_batch", "workflow_run",
  "batch_actions", "login_classic", "type_text", "humanize_type", "mouse_replay", "session_warmup", "os_click_xy"]);

function deadlineFor(name: string, args: any): number {
  if (LONG_RUNNING.has(name)) return 15 * 60 * 1000;
  const asked = Math.max(0, ...WAIT_ARGS.map(k => (typeof args?.[k] === "number" ? args[k] : 0)));
  return Math.max(DEADLINE_MS, asked + Math.min(DEADLINE_MS, 15000));
}

function errorReply(text: string) {
  return { content: [{ type: "text" as const, text: scrubErrorText(text) }], isError: true };
}

// Every tool shares three guarantees here:
//   a thrown error comes back as a clean isError reply with credentials scrubbed,
//   no call hangs past its deadline,
//   a dialog answered during the call is named in the reply.
function guarded(name: string, handler: Function) {
  return async (args: any, extra: any) => {
    const dialogsBefore = dialogLog.at(-1)?.seq ?? 0;
    const limit = deadlineFor(name, args);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<any>(resolve => {
      timer = setTimeout(() => resolve(errorReply(
        `${name} did not finish within ${Math.round(limit / 1000)}s, so it was abandoned. The page may be wedged. ` +
        `tab_new opens a fresh tab; browser_close and browser_launch start over.`)), limit);
    });
    const work = Promise.resolve().then(() => handler(args, extra)).catch((e: any) => errorReply(String(e?.message || e)));
    const res: any = await Promise.race([work, expired]);
    clearTimeout(timer);
    if (res?.isError) {
      for (const c of res.content || []) if (c.type === "text") c.text = scrubErrorText(c.text);
    }
    const fresh = dialogLog.filter(d => d.seq > dialogsBefore);
    if (fresh.length && Array.isArray(res?.content)) {
      // A separate content item: evaluate's own text must stay exactly its result.
      res.content.push({
        type: "text",
        text: fresh.map(d => `⚠ A ${d.type} dialog appeared during this call: "${d.message}". It was ${d.answer}.`).join("\n"),
      });
    }
    return res;
  };
}

// Every tool registers through here so workflow_run can invoke tools by name.
// Same signature as server.tool(name, description, schema, handler) — the schema
// is kept so a workflow step gets the same zod validation + defaults a real MCP
// call would get, instead of handlers seeing undefined for omitted params.
export const toolRegistry = new Map<string, { schema: any; handler: Function }>();
// Typed as server.tool itself so every handler keeps its inferred argument types.
export const regTool: typeof server.tool = ((name: any, description: any, schema: any, handler: any) => {
  const wrapped = guarded(name, handler);
  toolRegistry.set(name, { schema, handler: wrapped });
  return (server as any).tool(name, description, schema, wrapped);
}) as any;
