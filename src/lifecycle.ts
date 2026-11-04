// Stopping a browser and cleaning up after one, without ever touching a process or
// a folder this server cannot show is its own.
//
// Playwright exposes no PID for a persistent context, so a browser is found by the
// `-profile <dir>` it was started with. Only a descendant of THIS process is ever
// signalled: a shared pattern would also match a browser another agent or the
// developer is using.
import { execFileSync } from "child_process";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { PROFILE_PARENT } from "./state.js";

interface Proc { pid: number; ppid: number; command: string; }

export const CAN_VERIFY_PROCESSES = process.platform !== "win32";

function listProcesses(): Proc[] {
  if (!CAN_VERIFY_PROCESSES) return [];
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .map(l => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  } catch { return []; }
}

function usesProfile(p: Proc, dir: string): boolean {
  const flag = `-profile ${dir}`;
  const at = p.command.indexOf(flag);
  if (at < 0) return false;
  const next = p.command[at + flag.length];
  return next === undefined || next === " ";   // not a longer path sharing this prefix
}

function descendantsOfThisServer(all: Proc[]): Set<number> {
  const mine = new Set<number>([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) {
      if (mine.has(p.ppid) && !mine.has(p.pid)) { mine.add(p.pid); grew = true; }
    }
  }
  mine.delete(process.pid);
  return mine;
}

/** Any process at all still running on this profile, ours or not. */
export function processesOnProfile(dir: string): number[] {
  return listProcesses().filter(p => usesProfile(p, dir)).map(p => p.pid);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitUntilGone(dir: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (processesOnProfile(dir).length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

export interface StopResult {
  /** The process was positively seen to be gone. False is "could not tell" on a
   *  platform with no process listing, and "still running" when alive is non-empty. */
  verified: boolean;
  alive: number[];
  /** The graceful close failed or timed out and a signal was needed. */
  forced: boolean;
}

/** Close a context, then prove the browser is gone. Escalates only against this
 *  server's own descendants on this exact profile. */
export async function stopBrowser(ctx: { close(): Promise<void> } | null, dir: string | null, closeBudgetMs = 10000): Promise<StopResult> {
  if (ctx) {
    await Promise.race([ctx.close().catch(() => {}), sleep(closeBudgetMs)]);
  }
  if (!dir || !CAN_VERIFY_PROCESSES) return { verified: false, alive: [], forced: false };
  if (await waitUntilGone(dir, 3000)) return { verified: true, alive: [], forced: false };

  const signalMine = (signal: NodeJS.Signals) => {
    const all = listProcesses();
    const mine = descendantsOfThisServer(all);
    for (const p of all) {
      if (mine.has(p.pid) && usesProfile(p, dir)) { try { process.kill(p.pid, signal); } catch {} }
    }
  };
  signalMine("SIGTERM");
  if (await waitUntilGone(dir, 3000)) return { verified: true, alive: [], forced: true };
  signalMine("SIGKILL");
  if (await waitUntilGone(dir, 2000)) return { verified: true, alive: [], forced: true };
  return { verified: false, alive: processesOnProfile(dir), forced: true };
}

/** Remove a temp profile, unless something still runs on it. Deleting a profile
 *  under a live browser corrupts it and the browser's next write recreates it. */
export function removeTempProfile(dir: string): string | null {
  const running = processesOnProfile(dir);
  if (running.length) return `still in use by pid ${running.join(", ")}`;
  try { rmSync(dir, { recursive: true, force: true }); return null; }
  catch (e: any) { return String(e?.message || e); }
}

/** A temp profile name carries its owner's PID, so a later server can tell an
 *  abandoned one from one another live server is using. */
export function tempProfilePath(): string {
  return join(PROFILE_PARENT, `profile-fresh-p${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; }
}

/** Remove temp profiles left by a server that crashed. Only names in the current
 *  format qualify, only when the owning PID is dead, and only when no process is on
 *  the folder. An older name has no owner to check, so it is left alone and counted. */
export function sweepAbandonedTempProfiles(): { removed: number; unknownOwner: number } {
  const out = { removed: 0, unknownOwner: 0 };
  if (!CAN_VERIFY_PROCESSES || !existsSync(PROFILE_PARENT)) return out;
  let names: string[] = [];
  try { names = readdirSync(PROFILE_PARENT); } catch { return out; }
  for (const name of names) {
    if (!name.startsWith("profile-fresh-")) continue;
    const owner = name.match(/^profile-fresh-p(\d+)-/);
    if (!owner) { out.unknownOwner++; continue; }
    const pid = Number(owner[1]);
    if (pid === process.pid || pidAlive(pid)) continue;
    if (removeTempProfile(join(PROFILE_PARENT, name)) === null) out.removed++;
  }
  return out;
}
