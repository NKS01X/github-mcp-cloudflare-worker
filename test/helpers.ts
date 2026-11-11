/**
 * Test helpers: a scripted fake GitHub API and a real MCP client wired to the
 * Worker's fetch handler in-process (no network, no real token needed).
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Env } from "../src/env";
import { handleRequest } from "../src/index";

export const TEST_TOKEN = "github_pat_TESTTOKEN1234567890abcdefghijklmnopqrstuv";
export const TEST_KEY = "test-access-key-0123456789abcdef";

export interface RecordedCall {
  method: string;
  url: URL;
  path: string;
  headers: Headers;
  body: unknown;
}

type Responder = (call: RecordedCall) => Response | Promise<Response> | unknown;

interface Route {
  method: string;
  pattern: string | RegExp;
  respond: Responder;
  times?: number;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...headers },
  });
}

/** Scripted GitHub API: register routes, then pass `fake.fetch` to the server. */
export class FakeGitHub {
  readonly calls: RecordedCall[] = [];
  private routes: Route[] = [];

  on(method: string, pattern: string | RegExp, respond: Responder, times?: number): this {
    this.routes.push({ method, pattern, respond, times });
    return this;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else body = init?.body;
    const call: RecordedCall = { method, url, path: decodeURIComponent(url.pathname), headers, body };
    this.calls.push(call);

    const route = this.routes.find(
      (r) => r.method === method && (typeof r.pattern === "string" ? r.pattern === call.path : r.pattern.test(call.path)) && (r.times === undefined || r.times > 0),
    );
    if (!route) return jsonResponse({ message: `Not Found (no fake route for ${method} ${call.path})` }, 404);
    if (route.times !== undefined) route.times--;
    const out = await route.respond(call);
    return out instanceof Response ? out : jsonResponse(out);
  };

  callsTo(method: string, pattern: string | RegExp): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && (typeof pattern === "string" ? c.path === pattern : pattern.test(c.path)));
  }
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: TEST_TOKEN,
    MCP_ACCESS_KEY: TEST_KEY,
    GITHUB_TOOLSETS: "all",
    GITHUB_READ_ONLY: "false",
    GITHUB_API_URL: "https://api.github.com",
    ALLOW_UNAUTHENTICATED_MCP: "false",
    ...overrides,
  };
}

export const fakeCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

/** A fetch function that routes requests into the Worker (as Claude's connector would over HTTPS). */
export function workerFetch(env: Env, github: FakeGitHub) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    // Cloudflare always sets Host on incoming requests; Node's Request does not.
    if (!req.headers.has("host")) req.headers.set("host", new URL(req.url).host);
    return handleRequest(req, env, fakeCtx, github.fetch as typeof fetch);
  };
}

export async function connectClient(env: Env, github: FakeGitHub, opts: { protocolVersion?: string; modern?: boolean } = {}) {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    // Default: the 2025-11-25 initialize handshake (what deployed clients use today).
    // modern: pin the stateless 2026-07-28 protocol revision.
    opts.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined,
  );
  const transport = new StreamableHTTPClientTransport(new URL(`https://github-mcp-server.example.workers.dev/mcp/${TEST_KEY}`), {
    fetch: workerFetch(env, github) as typeof fetch,
    ...(opts.protocolVersion && { protocolVersion: opts.protocolVersion }),
  });
  await client.connect(transport);
  return client;
}

/** Parse a tool result's JSON text payload. */
export function resultJson(result: { content?: unknown; isError?: boolean }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

export function resultText(result: { content?: unknown }): string {
  return (result.content as Array<{ text: string }>)[0].text;
}

/** Raw JSON-RPC POST (legacy 2025 protocol, as older clients send it). Returns the parsed message. */
export async function rawRpc(env: Env, github: FakeGitHub, body: unknown, path = `/mcp/${TEST_KEY}`, headers: Record<string, string> = {}) {
  const res = await workerFetch(env, github)(`https://github-mcp-server.example.workers.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, headers: res.headers, text, message: dataLine ? JSON.parse(dataLine.slice(6)) : text ? JSON.parse(text) : undefined };
}
