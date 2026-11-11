// Finding and installing the Camoufox browser itself.
//
// Kept apart from the tools so a test can import it without starting a server. Both
// halves exist because of a shipped bug: the install used `npx camoufox-js fetch`,
// which resolves to whatever camoufox-js is newest, and the check looked only at
// version.json, which survives the browser being deleted.
import { execFileSync } from "child_process";
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
 *  0.10 cannot read, so a first launch downloaded 1.3 GB and then failed (issue #7). */
export function bundledFetchCommand(): { command: string; args: string[] } {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("camoufox-js/package.json")), "dist", "__main__.js");
  return { command: process.execPath, args: [cli, "fetch"] };
}

/** Make sure a browser is there to launch. Downloads on a first run only. */
export async function ensureCamoufoxBinary(): Promise<void> {
  const { executable, versionFile } = await camoufoxInstall();
  if (existsSync(versionFile)) {
    if (existsSync(executable)) return;
    // version.json without the browser is what deleting the app to free disk space
    // leaves behind. camoufox-js trusts the version file, so the launch used to die on
    // "ENOENT ... properties.json". It is not downloaded again unasked: the download is
    // over a gigabyte and somebody removed it on purpose.
    throw new Error(
      `Camoufox is not installed: ${executable} is missing, although ${versionFile} says a version was. ` +
      `The browser was probably deleted to free disk space. Reinstall it with \`${reinstallHint()}\` (a download of more than 1 GB), then call browser_launch again.`);
  }

  console.error("\n" + "=".repeat(60));
  console.error("[mcp-camoufox] First-time setup: downloading Camoufox (more than 1 GB)");
  console.error("[mcp-camoufox] Please wait 2-5 minutes...");
  console.error("=".repeat(60) + "\n");
  const { command, args } = bundledFetchCommand();
  // CRITICAL: the child's stdout goes to OUR stderr. stdio:'inherit' would put download
  // progress on the MCP JSON-RPC channel, and the client then fails to parse it
  // ("invalid character 'C' looking for beginning of value", issue #1).
  execFileSync(command, args, { stdio: ["ignore", 2, 2], timeout: 900000 });
  console.error("\n[mcp-camoufox] Download complete.\n");
}

/** A command a person can paste. It names the version this package uses, because a
 *  bare `npx camoufox-js fetch` is the command that broke first installs. */
export function reinstallHint(): string {
  let version = "";
  try { version = createRequire(import.meta.url)("camoufox-js/package.json").version || ""; } catch {}
  return `npx -y camoufox-js${version ? `@${version}` : ""} fetch`;
}
