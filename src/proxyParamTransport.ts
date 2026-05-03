/**
 * Dev / browser `/proxy` uses URL query params. `URLSearchParams` encodes `%` in the value,
 * so a target like `…/api/proxy/stream?url=http%3A%2F%2Fcdn…` becomes `…%253A%252F…` upstream.
 * When the target (or `from`) contains percent-encoded octets, we ship it as base64 instead.
 */

export function proxyQueryNeedsB64Transport(s: string): boolean {
  return /%[0-9A-Fa-f]{2}/i.test(s);
}

export function toBase64UrlUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64UrlUtf8(b64: string): string {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(norm);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function proxiedQueryString(target: string, from: string): string {
  if (proxyQueryNeedsB64Transport(target) || proxyQueryNeedsB64Transport(from)) {
    const te = encodeURIComponent(toBase64UrlUtf8(target));
    const fe = encodeURIComponent(toBase64UrlUtf8(from));
    return `targetB64=${te}&fromB64=${fe}`;
  }
  const p = new URLSearchParams();
  p.set("target", target);
  p.set("from", from);
  return p.toString();
}

export function proxiedFullUrl(
  proxyPrefix: string,
  target: string,
  fromPlaylist?: string
): string {
  const pfx = proxyPrefix.replace(/\/$/, "");
  const from = fromPlaylist ?? target;
  return `${pfx}?${proxiedQueryString(target, from)}`;
}
