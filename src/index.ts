/**
 * Cloudflare Worker entry point.
 *
 *   GET  /                 -> health/status JSON (no secrets)
 *   POST /mcp/<ACCESS_KEY> -> MCP Streamable HTTP endpoint (use this URL in Claude)
 *   POST /mcp              -> same, with "Authorization: Bearer <ACCESS_KEY>"
 *
 * The MCP endpoint is served by the Cloudflare Agents SDK's stateless
 * `createMcpHandler` with an MCP SDK v2 server built fresh for every request.
 * No Durable Objects, KV or databases are used.
 */
import { createMcpHandler } from "agents/mcp/server";
import { checkAccess } from "./auth";
import { SERVER_NAME, SERVER_VERSION, loadConfig } from "./config";
import type { Env } from "./env";
import { buildMcpServer } from "./server";
import { enabledTools } from "./tools/index";

const MCP_ROUTE = "/mcp";

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function jsonRpcError(status: number, message: string): Response {
  return json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, status, { "access-control-allow-origin": "*" });
}

/** Split "/mcp/<key>" into its key; undefined for plain "/mcp"; null for other paths. */
export function parseMcpPath(pathname: string): { key: string | undefined } | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === MCP_ROUTE) return { key: undefined };
  if (path.startsWith(`${MCP_ROUTE}/`)) {
    const rest = path.slice(MCP_ROUTE.length + 1);
    if (!rest || rest.includes("/")) return null;
    try {
      return { key: decodeURIComponent(rest) };
    } catch {
      return null;
    }
  }
  return null;
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, fetchImpl?: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const config = loadConfig(env);

  if (url.pathname === "/" || url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
    return json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      status: "ok",
      mcp_endpoint: `${url.origin}${MCP_ROUTE}/<MCP_ACCESS_KEY>`,
      transport: "streamable-http (stateless)",
      github_token_configured: Boolean(env.GITHUB_TOKEN?.trim()),
      mcp_access_key_configured: Boolean(env.MCP_ACCESS_KEY?.trim()) || config.allowUnauthenticated,
      read_only: config.readOnly,
      toolsets: [...config.toolsets],
      ...(config.unknownToolsets.length > 0 && { unknown_toolsets_ignored: config.unknownToolsets }),
      tool_count: enabledTools(config).length,
    });
  }

  const route = parseMcpPath(url.pathname);
  if (!route) return json({ error: "Not found", hint: `The MCP endpoint is ${MCP_ROUTE}/<MCP_ACCESS_KEY>` }, 404);

  // CORS preflight carries no credentials; let the MCP handler answer it.
  if (request.method !== "OPTIONS") {
    const access = await checkAccess({ pathKey: route.key, request, expectedKey: env.MCP_ACCESS_KEY, allowUnauthenticated: config.allowUnauthenticated });
    if (!access.ok) return jsonRpcError(access.status, access.reason);
  }

  // The SDK handler serves exactly MCP_ROUTE; strip the key from the path before handing over.
  const forwardUrl = new URL(url);
  forwardUrl.pathname = MCP_ROUTE;
  const forwarded = new Request(forwardUrl.toString(), request);

  const handler = createMcpHandler(() => buildMcpServer(env, config, fetchImpl), {
    route: MCP_ROUTE,
    onerror: (err) => console.error("[mcp]", err.message),
  });
  return handler(forwarded, env, ctx);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
