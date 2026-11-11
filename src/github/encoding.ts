/** UTF-8 safe base64 helpers using only Web APIs (no Node Buffer). */

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isValidBase64(b64: string): boolean {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(clean);
}

/**
 * Heuristic binary detection: NUL bytes or invalid UTF-8 means "binary".
 * Returns the decoded text when the bytes are text.
 */
export function decodeIfText(bytes: Uint8Array): { isText: true; text: string } | { isText: false } {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  if (sample.includes(0)) return { isText: false };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return { isText: true, text };
  } catch {
    return { isText: false };
  }
}
