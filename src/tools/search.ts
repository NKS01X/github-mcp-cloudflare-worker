import { z } from "zod";
import { compact, pick, summarizeIssue, summarizeRepo } from "../github/compact";
import type { GitHubClient } from "../github/client";
import { defineTool } from "./define";

const q = z
  .string()
  .min(1)
  .max(256)
  .describe("GitHub search query. Supports qualifiers, e.g. 'user:octocat language:typescript', 'org:acme is:open label:bug', 'repo:owner/name'.");

const perPage = z.number().int().min(1).max(100).default(30);
const page = z.number().int().min(1).max(10).default(1).describe("Page (search returns at most 1000 results = 10 pages of 100).");

async function search<T>(gh: GitHubClient, kind: string, query: Record<string, string | number | undefined>, accept?: string) {
  const res = await gh.request<{ total_count: number; incomplete_results: boolean; items: T[] }>("GET", `/search/${kind}`, { query, accept });
  const perPageValue = Number(query.per_page ?? 30);
  const pageValue = Number(query.page ?? 1);
  return {
    total_count: res.data.total_count,
    incomplete_results: res.data.incomplete_results,
    items: res.data.items,
    pagination: { page: pageValue, per_page: perPageValue, has_next_page: pageValue * perPageValue < Math.min(res.data.total_count, 1000) },
  };
}

export const searchTools = [
  defineTool({
    name: "search_repositories",
    toolset: "search",
    title: "Search repositories",
    description:
      "Search GitHub repositories by name, description, topic, language, owner, stars, etc. Examples: 'portfolio user:octocat', 'topic:react stars:>1000', 'org:acme archived:false pushed:<2025-01-01'. Private repositories are included when the token can see them.",
    input: z.object({ query: q, sort: z.enum(["stars", "forks", "help-wanted-issues", "updated"]).optional(), order: z.enum(["asc", "desc"]).default("desc"), per_page: perPage, page }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const r = await search<Record<string, unknown>>(gh, "repositories", { q: a.query, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page });
      return { ...r, items: r.items.map(summarizeRepo) };
    },
  }),

  defineTool({
    name: "search_code",
    toolset: "search",
    title: "Search code",
    description:
      "Search file CONTENTS across GitHub (default branches only, files under 384 KB). Use to find where a function/string is used: 'function parseDate repo:owner/name', 'useEffect language:tsx user:octocat', 'filename:package.json \"react\" org:acme', 'path:src/utils extension:ts'. Note: GitHub's code search API has a stricter rate limit (about 10 requests/minute).",
    input: z.object({ query: q, per_page: perPage, page, include_matches: z.boolean().default(true).describe("Include matching text fragments.") }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const r = await search<Record<string, unknown>>(gh, "code", { q: a.query, per_page: a.per_page, page: a.page }, a.include_matches ? "application/vnd.github.text-match+json" : undefined);
      return {
        ...r,
        items: r.items.map((i) => ({
          repository: (i.repository as Record<string, unknown>)?.full_name,
          path: i.path,
          sha: i.sha,
          html_url: i.html_url,
          ...(a.include_matches && { matches: ((i.text_matches as Array<Record<string, unknown>>) ?? []).map((m) => m.fragment) }),
        })),
      };
    },
  }),

  defineTool({
    name: "search_commits",
    toolset: "search",
    title: "Search commits",
    description: "Search commit messages and metadata. Examples: 'fix login repo:owner/name', 'author:octocat committer-date:>2026-01-01'.",
    input: z.object({ query: q, sort: z.enum(["author-date", "committer-date"]).optional(), order: z.enum(["asc", "desc"]).default("desc"), per_page: perPage, page }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const r = await search<Record<string, unknown>>(gh, "commits", { q: a.query, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page });
      return {
        ...r,
        items: r.items.map((c) => {
          const commit = c.commit as Record<string, unknown>;
          const author = commit.author as Record<string, unknown>;
          return { repository: (c.repository as Record<string, unknown>)?.full_name, sha: c.sha, message: String(commit.message).slice(0, 300), author: author?.name, date: author?.date, html_url: c.html_url };
        }),
      };
    },
  }),

  defineTool({
    name: "search_issues",
    toolset: "search",
    title: "Search issues",
    description:
      "Search issues across repositories (pull requests excluded automatically). Examples: 'repo:owner/name is:open label:bug', 'assignee:@me is:open', 'involves:octocat memory leak'.",
    input: z.object({
      query: q,
      sort: z.enum(["comments", "reactions", "created", "updated", "interactions"]).optional(),
      order: z.enum(["asc", "desc"]).default("desc"),
      per_page: perPage,
      page,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const query = /\bis:(issue|pr|pull-request)\b|\btype:(issue|pr)\b/.test(a.query) ? a.query : `${a.query} is:issue`;
      const r = await search<Record<string, unknown>>(gh, "issues", { q: query, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page });
      return { ...r, items: r.items.map((i) => ({ repository: String(i.repository_url ?? "").split("/repos/")[1], ...summarizeIssue(i) })) };
    },
  }),

  defineTool({
    name: "search_pull_requests",
    toolset: "search",
    title: "Search pull requests",
    description: "Search pull requests across repositories. Examples: 'repo:owner/name is:open review-requested:@me', 'author:octocat is:merged', 'is:open draft:false base:main'.",
    input: z.object({
      query: q,
      sort: z.enum(["comments", "reactions", "created", "updated", "interactions"]).optional(),
      order: z.enum(["asc", "desc"]).default("desc"),
      per_page: perPage,
      page,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const query = /\bis:(pr|pull-request)\b|\btype:pr\b/.test(a.query) ? a.query : `${a.query} is:pr`;
      const r = await search<Record<string, unknown>>(gh, "issues", { q: query, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page });
      return { ...r, items: r.items.map((i) => ({ repository: String(i.repository_url ?? "").split("/repos/")[1], ...summarizeIssue(i) })) };
    },
  }),

  defineTool({
    name: "search_users",
    toolset: "search",
    title: "Search users and organizations",
    description: "Search GitHub users/organizations. Examples: 'octocat', 'location:Berlin language:rust', 'type:org fullname:acme'.",
    input: z.object({ query: q, sort: z.enum(["followers", "repositories", "joined"]).optional(), order: z.enum(["asc", "desc"]).default("desc"), per_page: perPage, page }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const r = await search<Record<string, unknown>>(gh, "users", { q: a.query, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page });
      return { ...r, items: r.items.map((u) => pick(u, ["login", "type", "html_url"])) };
    },
  }),

  defineTool({
    name: "search_topics",
    toolset: "search",
    title: "Search topics",
    description: "Search GitHub topics (the tags repositories use), e.g. 'machine-learning is:featured'.",
    input: z.object({ query: q, per_page: perPage, page }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const r = await search<Record<string, unknown>>(gh, "topics", { q: a.query, per_page: a.per_page, page: a.page });
      return { ...r, items: r.items.map((t) => compact(pick(t, ["name", "display_name", "short_description", "featured", "curated", "created_by"]))) };
    },
  }),
];
