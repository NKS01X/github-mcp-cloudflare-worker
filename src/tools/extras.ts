import { z } from "zod";
import { compact, pick, summarizeRepo } from "../github/compact";
import { enc } from "../github/client";
import { ToolInputError } from "../github/errors";
import { confirmField, defineTool, pagination, repoArgs, requireConfirmation } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;
const hookId = z.number().int().positive().describe("Webhook ID (from list_repository_webhooks).");

function hookSummary(h: Record<string, unknown>) {
  const cfg = (h.config ?? {}) as Record<string, unknown>;
  return {
    id: h.id,
    active: h.active,
    events: h.events,
    url: cfg.url,
    content_type: cfg.content_type,
    insecure_ssl: cfg.insecure_ssl,
    has_secret: cfg.secret !== undefined,
    last_response: h.last_response,
    created_at: h.created_at,
  };
}

function gistSummary(g: Record<string, unknown>, withContent: boolean) {
  const files = (g.files ?? {}) as Record<string, Record<string, unknown>>;
  return {
    id: g.id,
    description: g.description,
    public: g.public,
    owner: (g.owner as Record<string, unknown> | undefined)?.login,
    created_at: g.created_at,
    updated_at: g.updated_at,
    html_url: g.html_url,
    files: Object.values(files).map((f) => ({
      filename: f.filename,
      language: f.language,
      size: f.size,
      ...(withContent && { truncated: f.truncated, content: f.content, raw_url: f.raw_url }),
    })),
  };
}

export const webhookTools = [
  defineTool({
    name: "list_repository_webhooks",
    toolset: "webhooks",
    title: "List repository webhooks",
    description: "List a repository's webhooks (target URL, events, active, last delivery result). Webhook secrets are never returned. Requires admin access ('Webhooks: read').",
    input: z.object({ ...repoArgs, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/hooks`, { per_page: a.per_page, page: a.page });
      return { webhooks: items.map(hookSummary), pagination: p };
    },
  }),

  defineTool({
    name: "create_repository_webhook",
    toolset: "webhooks",
    title: "Create a repository webhook",
    description: "Create a webhook that POSTs repository events to a URL. Common events: push, pull_request, issues, release, workflow_run. Use ['*'] for all events.",
    input: z.object({
      ...repoArgs,
      url: z.string().url().describe("HTTPS endpoint that receives the events."),
      events: z.array(z.string()).min(1).default(["push"]),
      content_type: z.enum(["json", "form"]).default("json"),
      secret: z.string().min(8).optional().describe("Shared secret GitHub uses to sign payloads (X-Hub-Signature-256). Never returned afterwards."),
      active: z.boolean().default(true),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      if (!a.url.startsWith("https://")) throw new ToolInputError("Use an https:// URL for webhooks.");
      const h = await gh.post<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/hooks`, {
        name: "web",
        active: a.active,
        events: a.events,
        config: { url: a.url, content_type: a.content_type, secret: a.secret, insecure_ssl: "0" },
      });
      return hookSummary(h);
    },
  }),

  defineTool({
    name: "update_repository_webhook",
    toolset: "webhooks",
    title: "Update a repository webhook",
    description: "Change a webhook's URL, events, content type, secret or active state.",
    input: z.object({
      ...repoArgs,
      hook_id: hookId,
      url: z.string().url().optional(),
      events: z.array(z.string()).min(1).optional(),
      content_type: z.enum(["json", "form"]).optional(),
      secret: z.string().min(8).optional(),
      active: z.boolean().optional(),
    }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      const config: Record<string, unknown> = {};
      if (a.url) config.url = a.url;
      if (a.content_type) config.content_type = a.content_type;
      if (a.secret) config.secret = a.secret;
      const body: Record<string, unknown> = { ...(a.events && { events: a.events }), ...(a.active !== undefined && { active: a.active }) };
      if (Object.keys(config).length) {
        // PATCH replaces the whole config object; merge with the current one.
        const current = await gh.get<{ config: Record<string, unknown> }>(`${repoPath(a.owner, a.repo)}/hooks/${a.hook_id}`);
        const merged = { ...current.config, ...config };
        if (merged.secret === "********") delete merged.secret;
        body.config = merged;
      }
      if (Object.keys(body).length === 0) throw new ToolInputError("Pass at least one field to change.");
      return hookSummary(await gh.patch(`${repoPath(a.owner, a.repo)}/hooks/${a.hook_id}`, body));
    },
  }),

  defineTool({
    name: "ping_repository_webhook",
    toolset: "webhooks",
    title: "Ping a webhook",
    description: "Send a 'ping' event to a webhook to test delivery.",
    input: z.object({ ...repoArgs, hook_id: hookId }),
    readOnly: false,
    handler: async (a, { gh }) => {
      await gh.post(`${repoPath(a.owner, a.repo)}/hooks/${a.hook_id}/pings`);
      return { pinged: a.hook_id };
    },
  }),

  defineTool({
    name: "delete_repository_webhook",
    toolset: "webhooks",
    title: "Delete a webhook",
    description: "Delete a repository webhook. Requires confirm = the webhook's ID as a string after explicit user approval.",
    input: z.object({ ...repoArgs, hook_id: hookId, confirm: confirmField("the webhook ID as a string, e.g. '12345'") }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      requireConfirmation(a.confirm, String(a.hook_id), `delete webhook ${a.hook_id}`);
      await gh.delete(`${repoPath(a.owner, a.repo)}/hooks/${a.hook_id}`);
      return { deleted_webhook: a.hook_id };
    },
  }),
];

export const gistTools = [
  defineTool({
    name: "list_gists",
    toolset: "gists",
    title: "List gists",
    description: "List your gists, or another user's public gists.",
    input: z.object({ username: z.string().optional().describe("Omit for your own gists."), since: z.string().datetime().optional(), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(a.username ? `/users/${enc(a.username)}/gists` : "/gists", { since: a.since, per_page: a.per_page, page: a.page });
      return { gists: items.map((g) => gistSummary(g, false)), pagination: p };
    },
  }),

  defineTool({
    name: "get_gist",
    toolset: "gists",
    title: "Get a gist",
    description: "Get a gist with the content of its files (files over ~1 MB are truncated; use raw_url).",
    input: z.object({ gist_id: z.string().min(1) }),
    readOnly: true,
    handler: async (a, { gh }) => gistSummary(await gh.get(`/gists/${enc(a.gist_id)}`), true),
  }),

  defineTool({
    name: "create_gist",
    toolset: "gists",
    title: "Create a gist",
    description: "Create a gist with one or more files. Secret (unlisted) by default.",
    input: z.object({
      description: z.string().optional(),
      public: z.boolean().default(false),
      files: z.record(z.string().min(1), z.string().min(1)).describe("Map of filename -> content, e.g. {'snippet.ts': '...'}."),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      if (Object.keys(a.files).length === 0) throw new ToolInputError("Provide at least one file.");
      const files = Object.fromEntries(Object.entries(a.files).map(([n, c]) => [n, { content: c }]));
      return gistSummary(await gh.post("/gists", { description: a.description, public: a.public, files }), false);
    },
  }),

  defineTool({
    name: "update_gist",
    toolset: "gists",
    title: "Update a gist",
    description: "Update a gist's description or files. Set a file's content to change it, rename via new_filename, or set delete: true to remove it.",
    input: z.object({
      gist_id: z.string().min(1),
      description: z.string().optional(),
      files: z
        .record(z.string().min(1), z.object({ content: z.string().optional(), new_filename: z.string().optional(), delete: z.boolean().default(false) }))
        .optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const files = a.files
        ? Object.fromEntries(Object.entries(a.files).map(([n, f]) => [n, f.delete ? null : { ...(f.content !== undefined && { content: f.content }), ...(f.new_filename && { filename: f.new_filename }) }]))
        : undefined;
      return gistSummary(await gh.patch(`/gists/${enc(a.gist_id)}`, { description: a.description, files }), false);
    },
  }),

  defineTool({
    name: "delete_gist",
    toolset: "gists",
    title: "Delete a gist",
    description: "Delete a gist permanently. Requires confirm = the gist ID after explicit user approval.",
    input: z.object({ gist_id: z.string().min(1), confirm: confirmField("the gist ID") }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      requireConfirmation(a.confirm, a.gist_id, `delete gist ${a.gist_id}`);
      await gh.delete(`/gists/${enc(a.gist_id)}`);
      return { deleted_gist: a.gist_id };
    },
  }),
];

export const notificationTools = [
  defineTool({
    name: "list_notifications",
    toolset: "notifications",
    title: "List notifications",
    description:
      "List your GitHub notifications (review requests, mentions, assignments, CI…), optionally for one repository. NOTE: GitHub only allows this with a classic token (notifications scope); fine-grained tokens get 403.",
    input: z.object({
      owner: z.string().optional(),
      repo: z.string().optional(),
      all: z.boolean().default(false).describe("Include already-read notifications."),
      participating: z.boolean().default(false).describe("Only where you are directly involved."),
      since: z.string().datetime().optional(),
      ...pagination,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      if ((a.owner && !a.repo) || (!a.owner && a.repo)) throw new ToolInputError("Pass both owner and repo, or neither.");
      const path = a.owner && a.repo ? `${repoPath(a.owner, a.repo)}/notifications` : "/notifications";
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(path, { all: a.all, participating: a.participating, since: a.since, per_page: a.per_page, page: a.page });
      return {
        notifications: items.map((n) => ({
          thread_id: n.id,
          reason: n.reason,
          unread: n.unread,
          updated_at: n.updated_at,
          repository: (n.repository as Record<string, unknown>)?.full_name,
          subject: pick((n.subject ?? {}) as Record<string, unknown>, ["title", "type", "url"]),
        })),
        pagination: p,
      };
    },
  }),

  defineTool({
    name: "mark_notifications_read",
    toolset: "notifications",
    title: "Mark notifications as read",
    description: "Mark one notification thread (thread_id), all notifications in a repository (owner+repo), or all notifications as read. Classic token only.",
    input: z.object({ thread_id: z.string().optional(), owner: z.string().optional(), repo: z.string().optional(), last_read_at: z.string().datetime().optional() }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      if (a.thread_id) {
        await gh.request("PATCH", `/notifications/threads/${enc(a.thread_id)}`, { responseType: "none" });
        return { marked_read: `thread ${a.thread_id}` };
      }
      if ((a.owner && !a.repo) || (!a.owner && a.repo)) throw new ToolInputError("Pass both owner and repo, or neither.");
      const path = a.owner && a.repo ? `${repoPath(a.owner, a.repo)}/notifications` : "/notifications";
      await gh.request("PUT", path, { body: { last_read_at: a.last_read_at, read: true }, responseType: "none" });
      return { marked_read: a.owner ? `${a.owner}/${a.repo}` : "all" };
    },
  }),
];

export const orgTools = [
  defineTool({
    name: "list_my_organizations",
    toolset: "orgs",
    title: "List my organizations",
    description: "List organizations the authenticated user belongs to (fine-grained tokens only see organizations they were granted access to).",
    input: z.object({ ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>("/user/orgs", { per_page: a.per_page, page: a.page });
      return { organizations: items.map((o) => pick(o, ["login", "description"])), pagination: p };
    },
  }),

  defineTool({
    name: "get_organization",
    toolset: "orgs",
    title: "Get an organization",
    description: "Get an organization's profile and settings visible to you.",
    input: z.object({ org: z.string().min(1) }),
    readOnly: true,
    handler: async (a, { gh }) =>
      compact(pick(await gh.get(`/orgs/${enc(a.org)}`), ["login", "name", "description", "blog", "location", "email", "is_verified", "public_repos", "total_private_repos", "plan", "default_repository_permission", "members_can_create_repositories", "two_factor_requirement_enabled", "created_at", "html_url"])),
  }),

  defineTool({
    name: "list_organization_members",
    toolset: "orgs",
    title: "List organization members",
    description: "List members of an organization, optionally filtered by role.",
    input: z.object({ org: z.string().min(1), role: z.enum(["all", "admin", "member"]).default("all"), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`/orgs/${enc(a.org)}/members`, { role: a.role, per_page: a.per_page, page: a.page });
      return { members: items.map((m) => m.login), pagination: p };
    },
  }),

  defineTool({
    name: "list_organization_teams",
    toolset: "orgs",
    title: "List organization teams",
    description: "List teams in an organization (slug, name, privacy). Team slugs are used for review requests.",
    input: z.object({ org: z.string().min(1), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`/orgs/${enc(a.org)}/teams`, { per_page: a.per_page, page: a.page });
      return { teams: items.map((t) => pick(t, ["slug", "name", "description", "privacy", "permission"])), pagination: p };
    },
  }),

  defineTool({
    name: "list_team_repositories",
    toolset: "orgs",
    title: "List a team's repositories",
    description: "List the repositories an organization team has access to.",
    input: z.object({ org: z.string().min(1), team_slug: z.string().min(1), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`/orgs/${enc(a.org)}/teams/${enc(a.team_slug)}/repos`, { per_page: a.per_page, page: a.page });
      return { repositories: items.map(summarizeRepo), pagination: p };
    },
  }),
];
