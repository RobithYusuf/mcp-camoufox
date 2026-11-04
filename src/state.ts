// Shared mutable runtime state.
//
// Everything the tools mutate lives on the single `S` record: an imported `let`
// binding cannot be assigned to from another module, so a plain export would
// have silently split the state in two the moment this file was created.
import type { BrowserContext, Page, Dialog } from "playwright-core";
import { mkdirSync } from "fs";
import { join } from "path";


export const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
export const PROFILE_PARENT = join(HOME_DIR, ".camoufox-mcp");
export const PROFILE_DIR = join(PROFILE_PARENT, "profile");
export const SCREENSHOT_DIR = join(PROFILE_PARENT, "screenshots");

// One mutable record instead of a dozen module-level `let`s, so this state can
// be shared across modules (an imported `let` binding cannot be assigned to).
export const S = {
  browserContext: null as BrowserContext | null,
  pages: [] as Page[],
  activePage: 0,
  browserUp: false,
  // Profile dir used by the current launch — a temp dir when fresh_profile=true,
  // PROFILE_DIR otherwise. Removed on close when temp.
  activeProfileDir: null as string | null,
  activeProfileIsTemp: false,
  // The MCP SDK dispatches requests concurrently, so two browser_launch calls can
  // both pass the "already running" guard and each build a context — the loser is
  // then unreachable by browser_close. Callers queue on this instead.
  launchInFlight: null as Promise<unknown> | null,
  // Set while browser_close or browser_recover is stopping the browser on purpose,
  // so the context's close event is not mistaken for a crash.
  stopping: false,
  // Why the last browser went away when no tool asked it to.
  lastExitNote: "",
  // console/network capture handlers, so they can be detached again
  consoleHandler: null as ((msg: any) => void) | null,
  networkHandler: null as ((res: any) => void) | null,
  // Dialog policy, read by the one listener trackPage attaches to every page. A
  // one-shot answer beats the persistent one; with neither, the dialog is dismissed.
  autoDialogCfg: null as { action: "accept" | "dismiss"; promptText: string } | null,
  oneShotDialog: null as { action: "accept" | "dismiss"; promptText: string } | null,
  networkCaptureBodies: false,
  networkSeq: 0,
  // Request interception. Routed on the CONTEXT, so tabs opened later are covered
  // without re-arming — and so a handler is never left attached per page.
  interceptHandler: null as null | ((route: any, request: any) => any),
  interceptBlocked: 0,
  interceptAllowed: 0,
};

export interface InterceptEntry { action: "block" | "allow"; type: string; url: string; why: string; }
export const interceptLog: InterceptEntry[] = [];

export function getPage(): Page {
  if (!S.browserUp) {
    throw new Error(`Browser not running.${S.lastExitNote ? ` ${S.lastExitNote}` : ""} Call browser_launch first.`);
  }
  if (S.pages.length === 0) {
    throw new Error("The browser is running but every tab is closed. Call tab_new to open one, or browser_close to stop it.");
  }
  if (S.activePage >= S.pages.length) S.activePage = 0;
  return S.pages[S.activePage];
}


// Every dialog the server has answered, newest last. A reply can then say a dialog
// appeared, which a page cannot be asked about afterwards.
export interface DialogEntry { seq: number; at: number; type: string; message: string; answer: string; }
export const dialogLog: DialogEntry[] = [];

// Buffers the capture tools share.
export const consoleMessages: { type: string; text: string }[] = [];
export interface NetEntry {
  id: number;
  ts: number;                        // capture time (ms epoch) — used by export_har
  method: string;
  status: number;
  url: string;                       // full URL (truncated only in list view)
  resourceType: string;
  reqHeaders?: Record<string, string>;
  reqBody?: string;
  resHeaders?: Record<string, string>;
  resBody?: string;
  resBodyTruncated?: boolean;
  mimeType?: string;
}
export const networkRequests: NetEntry[] = [];
export const storageSnapshots = new Map<string, any>();

export function ensureDirs(): void {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}
