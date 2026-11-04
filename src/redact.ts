// Credentials must not reach a tool reply by default. A reply lands in the agent's
// transcript and logs, so anything a network or cookie tool prints is effectively
// published. Every masking decision lives here so the tools cannot drift apart.
//
// Tools that need the real value take reveal_values=true. Files written with
// writeSecretFile are 0600 and are what a session is meant to be moved with.

const SECRET_ANYWHERE = /token|secret|passw|pwd|api_?key|access_?key|private_?key|cookie|authorization|sessid|session_?id|bearer|credential|jwt/i;
const SECRET_WORD = /^(auth|session|sess|sid|otp|totp|pin|cvv|csrf|xsrf|signature|sig)$/i;

/** Does this field, header, key or query parameter name hold a credential? */
export function isSecretName(name: string): boolean {
  // accessToken and access-token are the same field as access_token.
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.\s]/g, "_");
  if (SECRET_ANYWHERE.test(words)) return true;
  return words.split("_").some(w => SECRET_WORD.test(w));
}

export function maskedValue(v: unknown): string {
  return `***(${String(v ?? "").length} chars)`;
}

function maskPairs(raw: string, extra?: RegExp): string {
  return raw.split("&").map(piece => {
    const at = piece.indexOf("=");
    if (at < 0) return piece;
    let name = piece.slice(0, at);
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch {}
    return isSecretName(name) || extra?.test(name) ? `${piece.slice(0, at)}=${maskedValue(piece.slice(at + 1))}` : piece;
  }).join("&");
}

// In a URL, `key` and `code` are nearly always an API key and an OAuth code. As JSON
// or storage keys those two names are too ordinary to hide.
const URL_ONLY_SECRET = /^(key|code)$/i;

/** Hide credentials in a URL's query, fragment and user:pass@. Everything else stays
 *  byte for byte, so the URL can still be recognised. */
export function maskUrl(url: string): string {
  if (typeof url !== "string" || !url) return url;
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/i, "$1***@");
  const hash = out.indexOf("#");
  let fragment = "";
  if (hash >= 0) { fragment = out.slice(hash + 1); out = out.slice(0, hash); }
  const q = out.indexOf("?");
  if (q >= 0) out = out.slice(0, q + 1) + maskPairs(out.slice(q + 1), URL_ONLY_SECRET);
  if (hash >= 0) out += "#" + (fragment.includes("=") ? maskPairs(fragment, URL_ONLY_SECRET) : fragment);
  return out;
}

function maskCookieHeader(value: string): string {
  return value.split(/;\s*/).map(pair => {
    const at = pair.indexOf("=");
    return at < 0 ? pair : `${pair.slice(0, at)}=${maskedValue(pair.slice(at + 1))}`;
  }).join("; ");
}

// Playwright joins several Set-Cookie headers with a newline.
function maskSetCookie(value: string): string {
  return value.split("\n").map(line => {
    const [first, ...attrs] = line.split(";");
    const at = first.indexOf("=");
    const pair = at < 0 ? first : `${first.slice(0, at)}=${maskedValue(first.slice(at + 1))}`;
    return [pair, ...attrs].join(";");
  }).join("\n");
}

export function maskHeaderValue(name: string, value: string): string {
  const n = name.toLowerCase();
  if (n === "set-cookie") return maskSetCookie(String(value));
  if (n === "cookie") return maskCookieHeader(String(value));
  if (n === "location" || n === "referer" || n === "content-location") return maskUrl(String(value));
  return isSecretName(n) ? maskedValue(value) : String(value);
}

export function maskHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, maskHeaderValue(k, v)]));
}

function maskAll(node: any): any {
  if (Array.isArray(node)) return node.map(maskAll);
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, maskAll(v)]));
  return node === null || typeof node === "boolean" ? node : maskedValue(node);
}

export function maskJson(node: any): any {
  if (Array.isArray(node)) return node.map(maskJson);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, isSecretName(k) ? maskAll(v) : maskJson(v)]));
  }
  return node;
}

/** Bearer values and JWTs have a recognisable shape wherever they turn up. */
export function maskTokensInText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, (_m, kind) => `${kind} ***`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?/g, "***(jwt)");
}

/** Hide credential fields in a JSON or form body. Other text keeps its content apart
 *  from Bearer values and JWTs, because it cannot be read field by field. */
export function maskBody(body: string): string {
  if (typeof body !== "string" || !body) return body;
  const t = body.trim();
  if (t[0] === "{" || t[0] === "[") {
    try {
      const parsed = JSON.parse(t);
      const masked = maskJson(parsed);
      return JSON.stringify(masked) === JSON.stringify(parsed) ? maskTokensInText(body) : JSON.stringify(masked);
    } catch {}
  }
  if (/^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(t)) return maskPairs(t);
  return maskTokensInText(body);
}

/** A Playwright failure quotes the element it was looking at, value attribute and
 *  all, so `fill` on a disabled password field used to print the password back. */
export function scrubErrorText(message: string): string {
  return maskTokensInText(String(message ?? ""))
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\bvalue=(["'])(?:(?!\1).)*\1/g, 'value=$1***$1');
}
