import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION, type ServerConfig } from "./config";
import type { Env } from "./env";
import { GitHubClient } from "./github/client";
import { truncate } from "./github/compact";
import {
  ConfirmationRequiredError,
  GitHubApiError,
  GitHubNetworkError,
  GitHubRateLimitError,
  MissingTokenError,
  ToolInputError,
  UnsupportedOperationError,
} from "./github/errors";
import { TextResult, type ToolContext, type ToolDefinition } from "./tools/define";
import { ALL_TOOLS, enabledTools } from "./tools/index";

/** Hard cap on a single tool result, to protect Claude's context window. */
export const MAX_RESULT_CHARS = 200_000;

const INSTRUCTIONS = `GitHub tools backed by the GitHub REST and GraphQL APIs, authenticated with the server owner's token.
Workflow tips:
- "My repositories": call list_repositories (no owner) or get_authenticated_user to learn the username.
- Before editing a file, read it with get_file_contents; send the COMPLETE new content when writing.
- create_or_update_file / delete_file / commit_files / move_file commit AND push immediately; there is no separate push step. Use commit_files for multi-file changes in one commit.
- For a feature: create_branch (or commit_files with create_branch_from), commit, then create_pull_request.
- When branch is omitted, the repository's default branch is used.
- Destructive tools need a 'confirm' argument; only provide it after the user explicitly approves.
- Errors include a 'hint' describing how to fix the problem (permissions, not found, conflicts, rate limits).`;

type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function successResult(value: unknown, redact: (s: string) => string): CallToolResult {
  if (value instanceof TextResult) {
    const t = truncate(redact(value.text), MAX_RESULT_CHARS);
    return { content: [{ type: "text", text: t.text }], structuredContent: value.structured };
  }
  const structured = isPlainObject(value) ? value : { result: value ?? null };
  const json = redact(JSON.stringify(structured));
  if (json.length > MAX_RESULT_CHARS) {
    const t = truncate(json, MAX_RESULT_CHARS);
    return {
      content: [{ type: "text", text: `${t.text}\n[Result too large: narrow the request with filters, per_page, or paths.]` }],
    };
  }
  return { content: [{ type: "text", text: json }], structuredContent: JSON.parse(json) as Record<string, unknown> };
}

export function errorResult(err: unknown, redact: (s: string) => string): CallToolResult {
  let payload: Record<string, unknown>;
  if (err instanceof GitHubRateLimitError || err instanceof GitHubApiError) {
    payload = {
      type: err instanceof GitHubRateLimitError ? "rate_limited" : "github_api_error",
      status: err.status,
      message: err.message,
      hint: err.hint,
      ...err.details,
    };
  } else if (err instanceof ConfirmationRequiredError) {
    payload = { type: "confirmation_required", message: err.message, expected_confirm_value: err.expected };
  } else if (err instanceof ToolInputError) {
    payload = { type: "invalid_input", message: err.message };
  } else if (err instanceof UnsupportedOperationError) {
    payload = { type: "unsupported_operation", message: err.message };
  } else if (err instanceof MissingTokenError) {
    payload = { type: "server_not_configured", message: err.message };
  } else if (err instanceof GitHubNetworkError) {
    payload = { type: "network_error", message: err.message, hint: "GitHub could not be reached. Retry shortly." };
  } else {
    payload = { type: "internal_error", message: err instanceof Error ? err.message : String(err) };
  }
  const text = redact(JSON.stringify({ error: payload }));
  return { content: [{ type: "text", text }], isError: true };
}

export function createGitHubClient(env: Env, config: ServerConfig, fetchImpl?: typeof fetch): GitHubClient {
  return new GitHubClient({ token: env.GITHUB_TOKEN, apiUrl: config.apiUrl, graphqlUrl: config.graphqlUrl, fetchImpl });
}

/** Wrap a tool handler: run it, format success/errors, and never leak the token. */
export function wrapHandler(tool: ToolDefinition, ctx: ToolContext) {
  const redact = (s: string) => ctx.gh.redact(s);
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      const value = await tool.handler(args as never, ctx);
      return successResult(value, redact);
    } catch (err) {
      if (!(err instanceof GitHubApiError || err instanceof ToolInputError || err instanceof ConfirmationRequiredError || err instanceof MissingTokenError || err instanceof UnsupportedOperationError)) {
        // Unexpected failures are logged for the operator (token-redacted); expected ones are not noise.
        console.error(`[tool:${tool.name}]`, redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
      }
      return errorResult(err, redact);
    }
  };
}

type StandardProps = {
  version: 1;
  vendor: string;
  validate: (value: unknown) => unknown;
  jsonSchema: { input: (o: { target: string }) => Record<string, unknown>; output: (o: { target: string }) => Record<string, unknown> };
};
const schemaCache = new WeakMap<object, unknown>();

/**
 * Remove JSON Schema noise that costs tokens but tells Claude nothing:
 * the $schema URI, Zod's very long date-time regex (format: date-time says it),
 * and the implicit Number.MAX_SAFE_INTEGER maximum.
 */
export function slimJsonSchema(node: unknown, root = true): unknown {
  if (Array.isArray(node)) return node.map((n) => slimJsonSchema(n, false));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (root && k === "$schema") continue;
    if (k === "pattern" && obj.format === "date-time") continue;
    if (k === "maximum" && v === Number.MAX_SAFE_INTEGER) continue;
    if (k === "minimum" && v === Number.MIN_SAFE_INTEGER) continue;
    out[k] = slimJsonSchema(v, false);
  }
  return out;
}

/**
 * Wrap a Zod schema so its JSON Schema is generated once per Worker isolate
 * instead of on every request. Converting ~150 schemas costs tens of ms of CPU,
 * which matters on the Workers free plan (10 ms CPU per request).
 */
export function cachedSchema<T extends object>(schema: T): T {
  const hit = schemaCache.get(schema);
  if (hit) return hit as T;
  const std = (schema as unknown as { "~standard": StandardProps })["~standard"];
  const json = new Map<string, Record<string, unknown>>();
  const memo = (kind: "input" | "output", o: { target: string }) => {
    const k = `${kind}:${o.target}`;
    let v = json.get(k);
    if (!v) {
      v = slimJsonSchema(std.jsonSchema[kind](o)) as Record<string, unknown>;
      json.set(k, v);
    }
    return v;
  };
  const wrapped = {
    "~standard": {
      version: std.version,
      vendor: std.vendor,
      validate: (value: unknown) => std.validate(value),
      jsonSchema: { input: (o: { target: string }) => memo("input", o), output: (o: { target: string }) => memo("output", o) },
    },
  } as unknown as T;
  schemaCache.set(schema, wrapped);
  return wrapped;
}

/**
 * Generate every tool's JSON Schema once, at isolate startup. Startup CPU is
 * budgeted separately from per-request CPU, so the first tools/list request
 * doesn't pay for converting ~150 schemas.
 */
export function warmSchemaCache(): void {
  for (const tool of ALL_TOOLS) {
    const std = (cachedSchema(tool.input) as unknown as { "~standard": StandardProps })["~standard"];
    std.jsonSchema.input({ target: "draft-2020-12" });
  }
}
warmSchemaCache();

/** Build a fresh MCP server (one per request — the handler is stateless). */
export function buildMcpServer(env: Env, config: ServerConfig, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { gh: createGitHubClient(env, config, fetchImpl), config };

  for (const tool of enabledTools(config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: cachedSchema(tool.input),
        // Only non-default hints are sent (MCP defaults: readOnly=false, destructive=true,
        // idempotent=false, openWorld=true) to keep the tool list compact.
        annotations: tool.readOnly
          ? { readOnlyHint: true }
          : { destructiveHint: Boolean(tool.destructive), ...(tool.idempotent && { idempotentHint: true }) },
      },
      wrapHandler(tool, ctx) as never,
    );
  }
  return server;
}
