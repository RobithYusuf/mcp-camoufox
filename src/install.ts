// Finding and installing the Camoufox browser itself.
//
// Kept apart from the tools so a test can import it without starting a server. Both
// halves exist because of a shipped bug: the install used `npx camoufox-js fetch`,
// which resolves to whatever camoufox-js is newest, and the check looked only at
// version.json, which survives the browser being deleted.
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { homedir, platform } from "os";
import { dirname, join } from "path";

export interface CamoufoxInstall { dir: string; executable: string; versionFile: string; }

/** Where camoufox-js keeps the browser and what it starts. The directory is read from
 *  the library so the two cannot drift: the Windows path written here by hand pointed
 *  at a folder camoufox-js never used. */
export async function camoufoxInstall(): Promise<CamoufoxInstall> {
  const os = platform(), home = homedir();
  let dir = os === "darwin" ? join(home, "Library", "Caches", "camoufox")
    : os === "win32" ? join(home, "AppData", "Local", "camoufox", "camoufox", "Cache")
    : join(home, ".cache", "camoufox");
  try {
    const pkg: any = await import("camoufox-js/dist/pkgman.js" as string);
    if (pkg?.INSTALL_DIR) dir = String(pkg.INSTALL_DIR);
  } catch {}
  const executable = os === "darwin" ? join(dir, "Camoufox.app", "Contents", "MacOS", "camoufox")
    : os === "win32" ? join(dir, "camoufox.exe")
    : join(dir, "camoufox-bin");
  return { dir, executable, versionFile: join(dir, "version.json") };
}

/** The command that downloads the browser: the camoufox-js this package depends on,
 *  run with this Node. `npx camoufox-js fetch` instead resolved to the newest
 *  camoufox-js on a machine without it, and 0.13 stores the browser in a layout that
 *  0.10 cannot read, so a first launch downloaded 1.3 GB and then failed (issue #7).
 *  MCP_CAMOUFOX_FETCH_COMMAND (a JSON array) replaces it, so a test can stand in for a
 *  1.3 GB download; nothing else should set it. */
export function bundledFetchCommand(): { command: string; args: string[] } {
  const override = process.env.MCP_CAMOUFOX_FETCH_COMMAND;
  if (override) {
    const argv = JSON.parse(override);
    if (Array.isArray(argv) && argv.length && argv.every(a => typeof a === "string")) return { command: argv[0], args: argv.slice(1) };
  }
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("camoufox-js/package.json")), "dist", "__main__.js");
  return { command: process.execPath, args: [cli, "fetch"] };
}

// ── The first-run download ──────────────────────────────────────────────────
// It used to run with execFileSync inside browser_launch: about five minutes in which the
// whole server could answer nothing, not even server_status, and a client with a 60s
// tool timeout gave up while the download went on. It now runs in the background, and
// browser_launch waits a little, then says how far it got and to call again.

export interface DownloadState {
  state: "running" | "failed" | "done";
  startedAt: number;
  finishedAt?: number;
  percent: number | null;
  /** "465 MB/1.3 GB", as camoufox-js prints it. */
  progress: string;
  eta: string;
  /** What is being downloaded right now: Camoufox, then the GeoIP database and an addon. */
  stage: string;
  error?: string;
}

let download: { child: ChildProcess | null; done: Promise<void>; state: DownloadState } | null = null;

/** How long browser_launch waits on a running download before answering with its progress. */
const DOWNLOAD_WAIT_MS = Number(process.env.MCP_CAMOUFOX_DOWNLOAD_WAIT_MS) || 40000;

export function downloadState(): DownloadState | null { return download ? { ...download.state } : null; }

/** The fields of one camoufox-js progress line, e.g.
 *  "Downloading Camoufox... [████░░] 36% | ETA: 1m15s | 465 MB/1.3 GB". */
export function parseProgress(line: string): { stage: string; percent: number; eta: string; progress: string } | null {
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const m = clean.match(/(Downloading[^[]*?)\s*\[[^\]]*\]\s*(\d+)%\s*\|\s*ETA:\s*([^|]+?)\s*\|\s*(\S+\s*\w*\/\S+\s*\w*)/);
  if (!m) return null;
  return { stage: m[1].replace(/\.+$/, "").trim(), percent: Number(m[2]), eta: m[3].trim(), progress: m[4].trim() };
}

function startDownload(): void {
  const { command, args } = bundledFetchCommand();
  const state: DownloadState = { state: "running", startedAt: Date.now(), percent: null, progress: "", eta: "", stage: "starting" };
  let tail = "";
  // Progress bars redraw with \r. Everything goes to OUR stderr: the child's stdout must
  // never reach the MCP JSON-RPC channel (issue #1: "invalid character 'C'").
  const take = (chunk: Buffer) => {
    process.stderr.write(chunk);
    const text = chunk.toString();
    tail = (tail + text).slice(-2000);
    for (const piece of text.split(/[\r\n]+/)) {
      const p = parseProgress(piece);
      if (p) Object.assign(state, p);
    }
  };
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_yes: "true" } });
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const done = new Promise<void>(resolve => {
    const finish = async (error?: string) => {
      if (state.state !== "running") return;
      const { executable } = await camoufoxInstall();
      if (!error && !existsSync(executable)) error = `the download finished but ${executable} is not there`;
      state.finishedAt = Date.now();
      state.state = error ? "failed" : "done";
      if (error) {
        const last = tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/[\r\n]+/).map(l => l.trim()).filter(Boolean).slice(-2).join(" | ");
        state.error = `${error}${last ? `. Last output: ${last.slice(0, 300)}` : ""}`;
      }
      if (download?.child === child) download.child = null;
      resolve();
    };
    child.on("error", e => { void finish(String(e?.message || e)); });
    child.on("exit", (code, signal) => { void finish(code === 0 ? undefined : `the download exited with ${signal || `code ${code}`}`); });
  });
  download = { child, done, state };
}

/** Stop a download this server started, when the server itself is going away. A half
 *  download is harmless: the next one starts by clearing the folder. */
export function stopDownload(): void {
  try { download?.child?.kill("SIGTERM"); } catch {}
}

function describeProgress(s: DownloadState): string {
  const secs = Math.round((Date.now() - s.startedAt) / 1000);
  const where = s.percent === null ? "starting" : `${s.stage} ${s.percent}%${s.progress ? ` (${s.progress})` : ""}${s.eta ? `, about ${s.eta} left` : ""}`;
  return `${where}, ${secs}s so far`;
}

/** Make sure a browser is there to launch. A missing browser is downloaded in the
 *  background: this waits for it a while, then throws a reply that says how far it got.
 *  That covers a first install and a browser deleted to free disk space (version.json
 *  left behind), which used to end on "ENOENT ... properties.json". */
export async function ensureCamoufoxBinary(waitMs = DOWNLOAD_WAIT_MS): Promise<void> {
  const { executable } = await camoufoxInstall();
  if (existsSync(executable) && download?.state.state !== "running") return;
  let first = false;
  if (!download || download.state.state === "failed" || (download.state.state === "done" && !existsSync(executable))) {
    const previous = download?.state.state === "failed" ? download.state.error : "";
    first = !previous;
    console.error("\n[mcp-camoufox] Downloading the Camoufox browser (about 1.3 GB, 2.4 GB on disk). It happens once.\n");
    if (previous) console.error(`[mcp-camoufox] Retrying. The previous attempt failed: ${previous}`);
    startDownload();
  }
  const current = download!;
  const settled = await Promise.race([current.done.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), waitMs))]);
  if (settled && current.state.state === "done") {
    console.error("\n[mcp-camoufox] Download complete.\n");
    return;
  }
  if (settled && current.state.state === "failed") {
    throw new Error(`Camoufox could not be downloaded: ${current.state.error}. Call browser_launch again to retry, or run \`${reinstallHint()}\` in a terminal to see the full output.`);
  }
  throw new Error(
    `${first ? "Camoufox, the browser this server drives, is not installed yet, so it is being downloaded now" : "Camoufox is still downloading"}: ` +
    `${describeProgress(current.state)}. This happens once and usually takes 2 to 5 minutes (about 1.3 GB). ` +
    `Call browser_launch again in a minute: it picks up this download and launches as soon as it finishes. ` +
    `server_status shows the progress. Tools that need no browser (http_request, scrape_markdown, smart_fetch, search) work meanwhile.`);
}

/** A command a person can paste. It names the version this package uses, because a
 *  bare `npx camoufox-js fetch` is the command that broke first installs. */
export function reinstallHint(): string {
  let version = "";
  try { version = createRequire(import.meta.url)("camoufox-js/package.json").version || ""; } catch {}
  return `npx -y camoufox-js${version ? `@${version}` : ""} fetch`;
}
