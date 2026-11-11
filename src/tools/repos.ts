import { z } from "zod";
import { compact, pick, summarizeRepo } from "../github/compact";
import { enc } from "../github/client";
import { ToolInputError } from "../github/errors";
import { confirmField, defineTool, owner, pagination, repoArgs, requireConfirmation } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;

const REPO_DETAIL_KEYS = [
  "full_name", "description", "homepage", "private", "visibility", "fork", "archived", "disabled", "is_template",
  "default_branch", "language", "topics", "license", "size", "stargazers_count", "watchers_count", "forks_count",
  "open_issues_count", "has_issues", "has_projects", "has_wiki", "has_pages", "has_discussions",
  "allow_merge_commit", "allow_squash_merge", "allow_rebase_merge", "allow_auto_merge", "delete_branch_on_merge",
  "squash_merge_commit_title", "squash_merge_commit_message", "web_commit_signoff_required",
  "permissions", "owner", "parent", "source", "created_at", "updated_at", "pushed_at", "html_url", "clone_url", "ssh_url",
];

function repoDetails(r: Record<string, unknown>) {
  const d = compact(pick(r, REPO_DETAIL_KEYS)) as Record<string, unknown>;
  if (d.license && typeof d.license === "object") d.license = (d.license as Record<string, unknown>).spdx_id;
  if (d.parent && typeof d.parent === "object") d.parent = (d.parent as Record<string, unknown>).full_name;
  if (d.source && typeof d.source === "object") d.source = (d.source as Record<string, unknown>).full_name;
  return d;
}

export const repoTools = [
  defineTool({
    name: "list_repositories",
    toolset: "repos",
    title: "List repositories",
    description:
      "List repositories. Without 'owner', lists repositories the authenticated user can access (own, collaborator, organization member). With 'owner', lists a user's or organization's repositories. Results include pushed_at/updated_at, so you can find stale repositories (sort by 'pushed' ascending). To find a repository by topic or content, use search_repositories instead.",
    input: z.object({
      owner: owner.optional().describe("User or organization whose repositories to list. Omit for the authenticated user's accessible repositories."),
      visibility: z.enum(["all", "public", "private"]).default("all").describe("Only applies when 'owner' is omitted."),
      affiliation: z.string().default("owner,collaborator,organization_member").describe("Only when 'owner' is omitted: comma list of owner, collaborator, organization_member."),
      type: z.enum(["all", "owner", "public", "private", "member", "forks", "sources"]).optional().describe("Repository type filter when 'owner' is given."),
      sort: z.enum(["created", "updated", "pushed", "full_name"]).default("pushed").describe("Sort field. 'pushed' = last code push."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction. Default desc for dates, asc for full_name."),
      ...pagination,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      let path = "/user/repos";
      const query: Record<string, string | number | undefined> = { sort: a.sort, direction: a.direction, per_page: a.per_page, page: a.page };
      if (a.owner) {
        const target = await gh.get<{ type: string }>(`/users/${enc(a.owner)}`);
        path = target.type === "Organization" ? `/orgs/${enc(a.owner)}/repos` : `/users/${enc(a.owner)}/repos`;
        query.type = a.type;
      } else {
        query.visibility = a.visibility;
        query.affiliation = a.affiliation;
      }
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(path, query);
      return { repositories: items.map(summarizeRepo), pagination: p };
    },
  }),

  defineTool({
    name: "get_repository",
    toolset: "repos",
    title: "Get repository details",
    description: "Get a repository's details and settings: default branch, visibility, merge settings, topics, license, your permissions, timestamps and URLs. Use the default_branch value when a branch is needed but not given.",
    input: z.object({ ...repoArgs }),
    readOnly: true,
    handler: async ({ owner, repo }, { gh }) => repoDetails(await gh.get(repoPath(owner, repo))),
  }),

  defineTool({
    name: "get_repository_languages",
    toolset: "repos",
    title: "Get repository languages",
    description: "Return the languages used in a repository with byte counts and percentages.",
    input: z.object({ ...repoArgs }),
    readOnly: true,
    handler: async ({ owner, repo }, { gh }) => {
      const langs = await gh.get<Record<string, number>>(`${repoPath(owner, repo)}/languages`);
      const total = Object.values(langs).reduce((s, n) => s + n, 0) || 1;
      return Object.fromEntries(Object.entries(langs).map(([k, v]) => [k, { bytes: v, percent: Math.round((v / total) * 1000) / 10 }]));
    },
  }),

  defineTool({
    name: "create_repository",
    toolset: "repos",
    title: "Create a repository",
    description:
      "Create a new repository for the authenticated user, or inside an organization when 'org' is set. Private by default. Set auto_init true to create an initial commit with a README so files and branches can be added immediately (an empty repository has no branch yet).",
    input: z.object({
      name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, '.', '-' or '_'").describe("Repository name, e.g. 'my-project'."),
      description: z.string().max(350).optional(),
      private: z.boolean().default(true).describe("true = private (default), false = public."),
      org: z.string().optional().describe("Organization to create the repository in. Omit for a personal repository."),
      auto_init: z.boolean().default(true).describe("Create an initial commit with a README (recommended)."),
      gitignore_template: z.string().optional().describe("e.g. 'Node', 'Python'. Requires auto_init."),
      license_template: z.string().optional().describe("SPDX-like key, e.g. 'mit', 'apache-2.0'. Requires auto_init."),
      homepage: z.string().url().optional(),
      has_issues: z.boolean().optional(),
      has_wiki: z.boolean().optional(),
      is_template: z.boolean().optional(),
    }),
    readOnly: false,
    handler: async ({ org, ...body }, { gh }) => {
      const r = await gh.post<Record<string, unknown>>(org ? `/orgs/${enc(org)}/repos` : "/user/repos", body);
      return { created: true, repository: repoDetails(r) };
    },
  }),

  defineTool({
    name: "fork_repository",
    toolset: "repos",
    title: "Fork a repository",
    description: "Fork a repository into your account or an organization. Forking is asynchronous on GitHub: the fork may take a few seconds before its files are available.",
    input: z.object({
      ...repoArgs,
      organization: z.string().optional().describe("Organization to fork into. Omit for your personal account."),
      name: z.string().optional().describe("Name for the fork. Defaults to the original name."),
      default_branch_only: z.boolean().default(false).describe("Only copy the default branch."),
    }),
    readOnly: false,
    handler: async ({ owner, repo, ...body }, { gh }) => {
      const r = await gh.post<Record<string, unknown>>(`${repoPath(owner, repo)}/forks`, body);
      return { forked: true, repository: repoDetails(r), note: "Fork creation is asynchronous; retry reads after a few seconds if they return 404/409." };
    },
  }),

  defineTool({
    name: "update_repository",
    toolset: "repos",
    title: "Update repository settings",
    description:
      "Change repository settings: description, homepage, visibility, default branch, features (issues/wiki/projects/discussions) and merge options. Only the fields you pass are changed. Use archive_repository to archive, replace_repository_topics for topics, and transfer_repository to move ownership.",
    input: z.object({
      ...repoArgs,
      name: z.string().regex(/^[A-Za-z0-9._-]+$/).optional().describe("New repository name (renames the repository; GitHub redirects the old URL)."),
      description: z.string().max(350).optional(),
      homepage: z.string().optional(),
      visibility: z.enum(["public", "private", "internal"]).optional().describe("Changing to public exposes all code and history."),
      default_branch: z.string().optional().describe("Branch must already exist."),
      has_issues: z.boolean().optional(),
      has_projects: z.boolean().optional(),
      has_wiki: z.boolean().optional(),
      has_discussions: z.boolean().optional(),
      is_template: z.boolean().optional(),
      allow_merge_commit: z.boolean().optional(),
      allow_squash_merge: z.boolean().optional(),
      allow_rebase_merge: z.boolean().optional(),
      allow_auto_merge: z.boolean().optional(),
      delete_branch_on_merge: z.boolean().optional(),
      allow_update_branch: z.boolean().optional(),
      squash_merge_commit_title: z.enum(["PR_TITLE", "COMMIT_OR_PR_TITLE"]).optional(),
      squash_merge_commit_message: z.enum(["PR_BODY", "COMMIT_MESSAGES", "BLANK"]).optional(),
      web_commit_signoff_required: z.boolean().optional(),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, ...changes }, { gh }) => {
      if (Object.keys(changes).length === 0) throw new ToolInputError("Pass at least one setting to change.");
      const r = await gh.patch<Record<string, unknown>>(repoPath(owner, repo), changes);
      return { updated: Object.keys(changes), repository: repoDetails(r) };
    },
  }),

  defineTool({
    name: "replace_repository_topics",
    toolset: "repos",
    title: "Set repository topics",
    description: "Replace all topics of a repository with the given list (pass an empty list to clear). Topics are lowercase, may contain hyphens, max 50 characters each.",
    input: z.object({
      ...repoArgs,
      topics: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/, "lowercase letters, digits and hyphens")).max(20),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, topics }, { gh }) => gh.put(`${repoPath(owner, repo)}/topics`, { names: topics }),
  }),

  defineTool({
    name: "archive_repository",
    toolset: "repos",
    title: "Archive or unarchive a repository",
    description:
      "Archive (make read-only) or unarchive a repository. Archiving requires confirm = 'owner/repo' after the user agrees. Unarchiving does not need confirmation.",
    input: z.object({
      ...repoArgs,
      archived: z.boolean().default(true).describe("true = archive, false = unarchive."),
      confirm: confirmField("'owner/repo' (only needed when archiving)"),
    }),
    readOnly: false,
    destructive: true,
    idempotent: true,
    handler: async ({ owner, repo, archived, confirm }, { gh }) => {
      if (archived) requireConfirmation(confirm, `${owner}/${repo}`, `archive ${owner}/${repo} (it becomes read-only)`);
      const r = await gh.patch<Record<string, unknown>>(repoPath(owner, repo), { archived });
      return { full_name: r.full_name, archived: r.archived };
    },
  }),

  defineTool({
    name: "delete_repository",
    toolset: "repos",
    title: "Delete a repository (irreversible)",
    description:
      "Permanently delete a repository with all its code, issues, pull requests and releases. Requires confirm = 'owner/repo' after the user has explicitly approved. The token needs the 'Administration: write' permission (classic: delete_repo scope). Consider archive_repository instead.",
    input: z.object({ ...repoArgs, confirm: confirmField("'owner/repo'") }),
    readOnly: false,
    destructive: true,
    handler: async ({ owner, repo, confirm }, { gh }) => {
      requireConfirmation(confirm, `${owner}/${repo}`, `permanently delete repository ${owner}/${repo}`);
      await gh.delete(repoPath(owner, repo));
      return { deleted: `${owner}/${repo}` };
    },
  }),

  defineTool({
    name: "transfer_repository",
    toolset: "repos",
    title: "Transfer repository ownership",
    description:
      "Transfer a repository to another user or organization. The new owner may need to accept. Requires confirm = 'owner/repo' after explicit user approval. Requires admin access.",
    input: z.object({
      ...repoArgs,
      new_owner: z.string().min(1).describe("User or organization that will receive the repository."),
      new_name: z.string().optional().describe("Optional new repository name."),
      confirm: confirmField("'owner/repo'"),
    }),
    readOnly: false,
    destructive: true,
    handler: async ({ owner, repo, new_owner, new_name, confirm }, { gh }) => {
      requireConfirmation(confirm, `${owner}/${repo}`, `transfer ${owner}/${repo} to ${new_owner}`);
      const r = await gh.post<Record<string, unknown>>(`${repoPath(owner, repo)}/transfer`, { new_owner, new_name });
      return { transfer_started: true, repository: repoDetails(r) };
    },
  }),

  defineTool({
    name: "list_collaborators",
    toolset: "repos",
    title: "List repository collaborators",
    description: "List users with access to a repository and their permission level. Requires push access to the repository.",
    input: z.object({ ...repoArgs, affiliation: z.enum(["outside", "direct", "all"]).default("all"), ...pagination }),
    readOnly: true,
    handler: async ({ owner, repo, affiliation, per_page, page }, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(owner, repo)}/collaborators`, { affiliation, per_page, page });
      return { collaborators: items.map((c) => ({ login: c.login, role: c.role_name, permissions: c.permissions })), pagination: p };
    },
  }),

  defineTool({
    name: "list_contributors",
    toolset: "repos",
    title: "List repository contributors",
    description: "List contributors to a repository sorted by number of commits.",
    input: z.object({ ...repoArgs, anon: z.boolean().default(false).describe("Include anonymous contributors."), ...pagination }),
    readOnly: true,
    handler: async ({ owner, repo, anon, per_page, page }, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(owner, repo)}/contributors`, { anon: anon ? "1" : undefined, per_page, page });
      return { contributors: items.map((c) => ({ login: c.login ?? c.name, contributions: c.contributions, type: c.type })), pagination: p };
    },
  }),

  defineTool({
    name: "get_collaborator_permission",
    toolset: "repos",
    title: "Check a user's repository permission",
    description: "Get the permission level (admin, maintain, write, triage, read, none) a user has on a repository.",
    input: z.object({ ...repoArgs, username: z.string().min(1) }),
    readOnly: true,
    handler: async ({ owner, repo, username }, { gh }) => {
      const r = await gh.get<Record<string, unknown>>(`${repoPath(owner, repo)}/collaborators/${enc(username)}/permission`);
      return { username, permission: r.permission, role_name: r.role_name };
    },
  }),

  defineTool({
    name: "add_collaborator",
    toolset: "repos",
    title: "Add or update a collaborator",
    description: "Invite a user to a repository (or change their permission). Personal repositories only support 'push'-level collaborators; organization repositories support all levels. The user receives an invitation they must accept.",
    input: z.object({
      ...repoArgs,
      username: z.string().min(1),
      permission: z.enum(["pull", "triage", "push", "maintain", "admin"]).default("push"),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, username, permission }, { gh }) => {
      const res = await gh.request<Record<string, unknown>>("PUT", `${repoPath(owner, repo)}/collaborators/${enc(username)}`, { body: { permission } });
      return res.status === 201 ? { invited: username, permission, invitation_id: res.data?.id } : { updated: username, permission };
    },
  }),

  defineTool({
    name: "remove_collaborator",
    toolset: "repos",
    title: "Remove a collaborator",
    description: "Remove a user's access to a repository. Requires confirm = the username after explicit user approval.",
    input: z.object({ ...repoArgs, username: z.string().min(1), confirm: confirmField("the username being removed") }),
    readOnly: false,
    destructive: true,
    idempotent: true,
    handler: async ({ owner, repo, username, confirm }, { gh }) => {
      requireConfirmation(confirm, username, `remove ${username} from ${owner}/${repo}`);
      await gh.delete(`${repoPath(owner, repo)}/collaborators/${enc(username)}`);
      return { removed: username };
    },
  }),
];
