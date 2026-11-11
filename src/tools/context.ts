import { z } from "zod";
import { compact, pick } from "../github/compact";
import { enc } from "../github/client";
import { ToolInputError } from "../github/errors";
import { defineTool } from "./define";

export const contextTools = [
  defineTool({
    name: "get_authenticated_user",
    toolset: "context",
    title: "Who am I on GitHub",
    description:
      "Return the GitHub account the server's token belongs to (login, name, plan) plus token information. Call this first when the user says 'my repositories' and you need their username, or to check that the token works.",
    input: z.object({}),
    readOnly: true,
    handler: async (_args, { gh }) => {
      const res = await gh.request<Record<string, unknown>>("GET", "/user");
      const u = res.data;
      const scopes = res.headers.get("x-oauth-scopes");
      const expiry = res.headers.get("github-authentication-token-expiration");
      return {
        user: compact(pick(u, ["login", "name", "email", "company", "location", "bio", "public_repos", "total_private_repos", "followers", "created_at", "html_url", "type"])),
        plan: (u.plan as Record<string, unknown> | undefined)?.name,
        token: {
          kind: scopes === null ? "fine-grained or GitHub App token (permissions are not listed in headers)" : "classic personal access token",
          ...(scopes !== null && { scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean) }),
          ...(expiry && { expires_at: expiry }),
        },
      };
    },
  }),

  defineTool({
    name: "get_rate_limit",
    toolset: "context",
    title: "Check API rate limits",
    description: "Show remaining GitHub API quota (core REST, search, code search, GraphQL) and when each resets. Use when calls start failing with rate-limit errors.",
    input: z.object({}),
    readOnly: true,
    handler: async (_args, { gh }) => {
      const data = await gh.get<{ resources: Record<string, { limit: number; remaining: number; used: number; reset: number }> }>("/rate_limit");
      const out: Record<string, unknown> = {};
      for (const key of ["core", "search", "code_search", "graphql"]) {
        const r = data.resources?.[key];
        if (r) out[key] = { limit: r.limit, remaining: r.remaining, used: r.used, resets_at: new Date(r.reset * 1000).toISOString() };
      }
      return out;
    },
  }),

  defineTool({
    name: "get_user",
    toolset: "context",
    title: "Get a GitHub user or organization profile",
    description: "Get public profile information for any GitHub user or organization by login.",
    input: z.object({ username: z.string().min(1).max(100).describe("GitHub login (user or organization).") }),
    readOnly: true,
    handler: async ({ username }, { gh }) => {
      const u = await gh.get<Record<string, unknown>>(`/users/${enc(username)}`);
      return compact(pick(u, ["login", "type", "name", "company", "blog", "location", "email", "bio", "public_repos", "public_gists", "followers", "following", "created_at", "updated_at", "html_url"]));
    },
  }),

  defineTool({
    name: "get_github_meta",
    toolset: "context",
    title: "Get GitHub API metadata",
    description: "Return GitHub instance metadata (API version info, SSH key fingerprints, and optionally the IP ranges GitHub uses for hooks, Actions, etc.).",
    input: z.object({ include_ip_ranges: z.boolean().default(false).describe("Include the (long) lists of IP ranges.") }),
    readOnly: true,
    handler: async ({ include_ip_ranges }, { gh }) => {
      const res = await gh.request<Record<string, unknown>>("GET", "/meta");
      const meta = res.data;
      const out: Record<string, unknown> = {
        api_version_used: res.headers.get("x-github-api-version-selected"),
        verifiable_password_authentication: meta.verifiable_password_authentication,
        ssh_key_fingerprints: meta.ssh_key_fingerprints,
      };
      if (include_ip_ranges) {
        for (const [k, v] of Object.entries(meta)) if (Array.isArray(v)) out[k] = v;
      } else {
        out.ip_range_lists_available = Object.entries(meta).filter(([, v]) => Array.isArray(v)).map(([k]) => k);
      }
      return out;
    },
  }),

  defineTool({
    name: "graphql_query",
    toolset: "context",
    title: "Run a GitHub GraphQL query",
    description:
      "Escape hatch: run a GitHub GraphQL (v4) query for data the other tools do not cover (e.g. Projects v2, sponsors, complex nested data). Queries only, unless allow_mutation is true. Prefer the dedicated tools when one exists.",
    input: z.object({
      query: z.string().min(1).max(20_000).describe("GraphQL document, e.g. 'query($o:String!){ repositoryOwner(login:$o){ login } }'."),
      variables: z.record(z.string(), z.unknown()).optional().describe("Variables object for the query."),
      allow_mutation: z.boolean().default(false).describe("Must be true to run a mutation. Only set after the user approved the change."),
    }),
    readOnly: false,
    destructive: true,
    handler: async ({ query, variables, allow_mutation }, { gh, config }) => {
      const isMutation = /^\s*(#[^\n]*\n\s*)*mutation\b/i.test(query) || /\bmutation\s*[({]/i.test(query);
      if (isMutation && (!allow_mutation || config.readOnly)) {
        throw new ToolInputError(
          config.readOnly ? "This server runs in read-only mode; GraphQL mutations are disabled." : "This is a GraphQL mutation. Set allow_mutation to true (after the user approves) to run it.",
        );
      }
      return await gh.graphql(query, variables ?? {});
    },
  }),
];
