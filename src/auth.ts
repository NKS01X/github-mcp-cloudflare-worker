/**
 * MCP endpoint authentication (who may talk to this server).
 *
 * This is separate from GitHub authentication (what this server may do on
 * GitHub, controlled by GITHUB_TOKEN).
 *
 * Claude's custom connector UI accepts a URL plus optional OAuth settings; it
 * cannot attach a custom header. The simplest secure mechanism that works there
 * without OAuth infrastructure is a long random key in the URL path:
 *
 *     https://<worker>.workers.dev/mcp/<MCP_ACCESS_KEY>
 *
 * Clients that can send headers (Claude Code, MCP Inspector, scripts) may use
 * `POST /mcp` with `Authorization: Bearer <MCP_ACCESS_KEY>` instead.
 */

const MIN_KEY_LENGTH = 16;

export type AuthResult =
  | { ok: true; via: "path" | "header" | "disabled" }
  | { ok: false; status: number; reason: string };

/** Constant-time string comparison (avoids leaking the key through timing). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export function extractBearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

export async function checkAccess(opts: {
  pathKey: string | undefined;
  request: Request;
  expectedKey: string | undefined;
  allowUnauthenticated: boolean;
}): Promise<AuthResult> {
  if (opts.allowUnauthenticated) return { ok: true, via: "disabled" };

  const expected = opts.expectedKey?.trim();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      reason:
        "MCP_ACCESS_KEY is not configured on this Worker, so the endpoint is locked. Run `npm run deploy` (it creates the key automatically) or `npx wrangler secret put MCP_ACCESS_KEY`.",
    };
  }
  if (expected.length < MIN_KEY_LENGTH) {
    return { ok: false, status: 503, reason: `MCP_ACCESS_KEY must be at least ${MIN_KEY_LENGTH} characters.` };
  }

  if (opts.pathKey !== undefined && (await safeEqual(opts.pathKey, expected))) return { ok: true, via: "path" };
  const bearer = extractBearer(opts.request);
  if (bearer !== undefined && (await safeEqual(bearer, expected))) return { ok: true, via: "header" };

  return { ok: false, status: 401, reason: "Missing or invalid MCP access key." };
}
