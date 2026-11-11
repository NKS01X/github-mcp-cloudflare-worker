import type { Env } from "./env";

export const SERVER_NAME = "github-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** GitHub REST API version sent with every request. */
export const GITHUB_API_VERSION = "2026-03-10";

export const TOOLSETS = [
  "context",
  "repos",
  "files",
  "git",
  "branches",
  "pulls",
  "issues",
  "discussions",
  "search",
  "actions",
  "releases",
  "webhooks",
  "gists",
  "notifications",
  "orgs",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export interface ServerConfig {
  toolsets: Set<Toolset>;
  readOnly: boolean;
  apiUrl: string;
  graphqlUrl: string;
  allowUnauthenticated: boolean;
  /** Names in GITHUB_TOOLSETS that are not valid toolsets (reported on the health page). */
  unknownToolsets: string[];
}

function isTrue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function loadConfig(env: Env): ServerConfig {
  const raw = (env.GITHUB_TOOLSETS ?? "all").trim().toLowerCase();
  const toolsets = new Set<Toolset>();
  const unknownToolsets: string[] = [];
  if (raw === "" || raw === "all") {
    for (const t of TOOLSETS) toolsets.add(t);
  } else {
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if ((TOOLSETS as readonly string[]).includes(part)) toolsets.add(part as Toolset);
      else unknownToolsets.push(part);
    }
    // The "context" toolset (who am I, rate limits) is always useful and harmless.
    toolsets.add("context");
  }

  const apiUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  // github.com uses https://api.github.com/graphql; GHES uses https://HOST/api/graphql.
  const graphqlUrl = apiUrl.endsWith("/api/v3") ? apiUrl.replace(/\/api\/v3$/, "/api/graphql") : `${apiUrl}/graphql`;

  return {
    toolsets,
    readOnly: isTrue(env.GITHUB_READ_ONLY),
    apiUrl,
    graphqlUrl,
    allowUnauthenticated: isTrue(env.ALLOW_UNAUTHENTICATED_MCP),
    unknownToolsets,
  };
}
