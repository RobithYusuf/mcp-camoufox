// The device a persistent profile shows a site, kept with the profile.
//
// Left to camoufox-js, every launch drew a new screen, colour depth, GPU and core count
// (10 launches of one persistent profile: 10 different devices), while the profile kept
// the same logins: a site that remembers devices saw one account move to a new machine
// every session. A persistent profile now draws its device once and keeps it in the
// profile folder, so reset_profile removes it with the logins. A temp profile stays
// random. The canvas noise still changes per launch; see drawIdentity.
//
// What is stored is camoufox-js's own input (the browserforge fingerprint and a WebGL
// vendor/renderer pair), not its output. camoufox-js puts the installed
// browser's version into the user agent while it converts the fingerprint, so an
// identity drawn under Firefox 147 still says 158 once 158 is installed.
//
// This module only imports camoufox-js lazily, and has no tool imports, so a test can
// load it.
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeSecretFile } from "./helpers.js";

export const IDENTITY_FILE = "mcp-identity.json";
type Os = "windows" | "macos" | "linux";

export interface Identity {
  v: 1;
  created: string;
  os: Os;
  fingerprint: any;
  webgl: [string, string];
}

/** What browser_launch hands camoufox-js, and what its reply says about it. */
export interface IdentityLaunch { options: Record<string, unknown>; note: string; }

const OS_CODE: Record<Os, string> = { windows: "win", macos: "mac", linux: "lin" };

export function uaOs(ua: string): Os | null {
  return /Windows/.test(ua) ? "windows" : /Macintosh|Mac OS X/.test(ua) ? "macos" : /Linux|X11/.test(ua) ? "linux" : null;
}

/** The stored identity, or null when there is none or it cannot be used. */
export function readIdentity(profileDir: string): Identity | null {
  const file = join(profileDir, IDENTITY_FILE);
  if (!existsSync(file)) return null;
  try {
    const id = JSON.parse(readFileSync(file, "utf8"));
    const sc = id?.fingerprint?.screen, ua = id?.fingerprint?.navigator?.userAgent;
    if (id?.v !== 1 || typeof ua !== "string" || uaOs(ua) !== id.os || !(sc?.width > 0 && sc?.height > 0)
      || !Array.isArray(id.webgl) || id.webgl.length !== 2 || id.webgl.some((x: unknown) => typeof x !== "string")) return null;
    return id;
  } catch { return null; }
}

/** camoufox-js's handleWindowSize (fingerprints.js), which it applies only to a
 *  fingerprint it draws itself: the window centred on the screen, inner size following. */
export function fitWindow(fingerprint: any, outerWidth: number, outerHeight: number): any {
  const fp = JSON.parse(JSON.stringify(fingerprint));
  const sc = { ...fp.screen, screenY: undefined as number | undefined };
  sc.screenX += Math.floor((sc.width - outerWidth) / 2);
  sc.screenY = Math.floor((sc.height - outerHeight) / 2);
  if (sc.innerWidth) sc.innerWidth = Math.max(outerWidth - sc.outerWidth + sc.innerWidth, 0);
  if (sc.innerHeight) sc.innerHeight = Math.max(outerHeight - sc.outerHeight + sc.innerHeight, 0);
  sc.outerWidth = outerWidth;
  sc.outerHeight = outerHeight;
  fp.screen = sc;
  return fp;
}

/** A fingerprint that leaves window.innerWidth and innerHeight to the real viewport.
 *
 *  fingerprint-generator 2.1.82 left them at 0, and camoufox-js skips a 0, so the page saw
 *  the real 1280x720 viewport inside a 1280x800 window. 2.1.90, which every fresh install
 *  resolves, fills them in as the window's OUTER size. Camoufox then spoofed innerHeight
 *  to 800 while the page laid out in 720: a window with no browser chrome, and an
 *  innerHeight that disagrees with documentElement.clientHeight, which any page can
 *  compare. Measured on the published 0.13.0 from npx; the repo's older lockfile hid it. */
export function withRealInnerSize(fingerprint: any): any {
  const fp = JSON.parse(JSON.stringify(fingerprint));
  if (fp?.screen) { fp.screen.innerWidth = 0; fp.screen.innerHeight = 0; }
  return fp;
}

const NO_SCREEN = /No headers based on this input|relax or change some of the requirements/i;

// Internals of the camoufox-js this package pins (^0.10.2). A version that moved them fails
// here, and browser_launch then says the identity could not be kept.
const loadGenerator = () => import("camoufox-js/dist/fingerprints.js" as string);
const loadWebGL = () => import("camoufox-js/dist/webgl/sample.js" as string);

async function drawIdentity(os: Os | undefined, screen: { minWidth: number; minHeight: number } | null): Promise<Identity | null> {
  const { generateFingerprint } = await loadGenerator();
  const { sampleWebGL } = await loadWebGL();
  let fingerprint: any;
  try {
    fingerprint = generateFingerprint(undefined, { ...(screen ? { screen } : {}), ...(os ? { operatingSystems: [os] } : {}) });
  } catch (e: any) {
    if (!screen || !NO_SCREEN.test(String(e?.message || e))) throw e;
    return null;   // no screen holds this window
  }
  // The generator does not always refuse: asked for a 5000x3060 screen it handed back
  // 1920x1080 (windows) and 2056x1329 (macos). Stored, that device failed the fit check on
  // the next launch at the same size and a new one was drawn every time.
  if (screen && !(fingerprint?.screen?.width >= screen.minWidth && fingerprint?.screen?.height >= screen.minHeight)) return null;
  const drawnOs = uaOs(String(fingerprint?.navigator?.userAgent || ""));
  if (!drawnOs) throw new Error("the drawn fingerprint names no known OS");
  const gl = await sampleWebGL(OS_CODE[drawnOs]);
  // Not stored: the canvas anti-aliasing and font-spacing seeds camoufox-js draws per
  // launch. Pinned, neither changed anything measured (a text width stayed the same over
  // 20 launches with random seeds), and the canvas noise changes per launch anyway: on an
  // http page even a filled rectangle hashed differently in every launch with the
  // fingerprint, canvas:aaOffset and canvas:seed all fixed.
  return { v: 1, created: new Date().toISOString(), os: drawnOs, fingerprint, webgl: [String(gl["webGl:vendor"]), String(gl["webGl:renderer"])] };
}

/** The identity for a launch on a persistent profile: the stored one when it fits the
 *  request, else a new one, written back. An explicit request wins: an OS other than the
 *  stored one, or a window its screen cannot hold, draws a new device, and the note says
 *  why. A window no generated screen can hold keeps the stored device. */
export async function profileIdentity(
  profileDir: string,
  want: { os: Os | undefined; window: [number, number] | null; screen: { minWidth: number; minHeight: number } | null },
): Promise<IdentityLaunch> {
  const file = join(profileDir, IDENTITY_FILE);
  let stored = readIdentity(profileDir);
  let reason = "";
  if (!stored) reason = existsSync(file) ? "the stored one could not be read" : "first launch of this profile";
  else {
    // A pair camoufox-js does not know makes the launch itself fail ("No WebGL data found"),
    // on every launch of this profile until its logins are deleted.
    const { sampleWebGL } = await loadWebGL();
    try { await sampleWebGL(OS_CODE[stored.os], stored.webgl[0], stored.webgl[1]); }
    catch { reason = `its WebGL pair is not one camoufox-js knows for ${stored.os}`; stored = null; }
  }
  let fitOnly = false;
  if (stored && want.os && stored.os !== want.os) reason = `os=${want.os} was asked and this profile's device is ${stored.os}`;
  else if (stored && want.screen && (stored.fingerprint.screen.width < want.screen.minWidth || stored.fingerprint.screen.height < want.screen.minHeight)) {
    reason = `the ${want.window?.[0]}x${want.window?.[1]} window does not fit this profile's ${stored.fingerprint.screen.width}x${stored.fingerprint.screen.height} screen`;
    fitOnly = true;
  }
  let id: Identity, note: string;
  if (!reason && stored) {
    id = stored;
    note = `Identity: kept this profile's device (since ${stored.created.slice(0, 10)}).`;
  } else {
    let drawn = await drawIdentity(want.os, want.screen);
    if (!drawn && fitOnly && stored) {
      id = stored;
      note = `Identity: kept this profile's device. No screen holds a ${want.window?.[0]}x${want.window?.[1]} window, so a new one would not fit either.`;
    } else {
      // No screen holds the window: a device without that limit, as a launch without a
      // stored device gets, and the viewport fit in browser_launch takes it from there.
      if (!drawn) drawn = await drawIdentity(want.os, null);
      if (!drawn) throw new Error("could not draw a fingerprint");
      writeSecretFile(file, JSON.stringify(drawn));
      id = drawn;
      note = `Identity: new device for this profile (${reason}). Later launches reuse it.`;
    }
  }
  const fingerprint = withRealInnerSize(want.window ? fitWindow(id.fingerprint, want.window[0], want.window[1]) : id.fingerprint);
  return { options: { fingerprint, os: id.os, webgl_config: id.webgl }, note };
}

/** A new random device for one launch of a temp profile, built the same way as a
 *  persistent profile's so it goes through withRealInnerSize too. Left to camoufox-js, a
 *  temp profile got the generator's inner size. Nothing is stored. */
export async function tempIdentity(
  want: { os: Os | undefined; window: [number, number] | null; screen: { minWidth: number; minHeight: number } | null },
): Promise<IdentityLaunch> {
  let drawn = await drawIdentity(want.os, want.screen);
  if (!drawn) drawn = await drawIdentity(want.os, null);
  if (!drawn) throw new Error("could not draw a fingerprint");
  const fingerprint = withRealInnerSize(want.window ? fitWindow(drawn.fingerprint, want.window[0], want.window[1]) : drawn.fingerprint);
  return { options: { fingerprint, os: drawn.os, webgl_config: drawn.webgl }, note: "Identity: random, as for every temp profile." };
}
