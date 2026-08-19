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
  // console/network/dialog capture handlers, so they can be detached again
  consoleHandler: null as ((msg: any) => void) | null,
  networkHandler: null as ((res: any) => void) | null,
  autoDialogHandler: null as ((d: Dialog) => void) | null,
  autoDialogCfg: null as { action: "accept" | "dismiss"; promptText: string } | null,
  oneShotDialogArmed: false,
  // The live one-shot dialog handler, so trackPage can arm tabs opened later.
  oneShotDialogHandler: null as null | ((d: any) => any),
  networkCaptureBodies: false,
  networkSeq: 0,
};

export function getPage(): Page {
  if (!S.browserUp || S.pages.length === 0) {
    throw new Error("Browser not running. Call browser_launch first.");
  }
  if (S.activePage >= S.pages.length) S.activePage = 0;
  return S.pages[S.activePage];
}


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
