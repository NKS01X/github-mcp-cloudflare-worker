import { z } from "zod";
import { compact, pick, summarizeIssue } from "../github/compact";
import { enc } from "../github/client";
import { ToolInputError } from "../github/errors";
import { defineTool, issueNumber, pagination, repoArgs } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;
const issuePath = (o: string, r: string, n: number) => `${repoPath(o, r)}/issues/${n}`;

function issueDetails(i: Record<string, unknown>) {
  const d = summarizeIssue(i);
  d.body = i.body ?? "";
  if (i.closed_by) d.closed_by = compact(i.closed_by);
  if (i.locked) d.locked = true;
  return d;
}

const comment = (c: Record<string, unknown>) => compact(pick(c, ["id", "user", "body", "created_at", "updated_at", "html_url"]));

export const issueTools = [
  defineTool({
    name: "list_issues",
    toolset: "issues",
    title: "List issues",
    description:
      "List issues in a repository filtered by state, labels, assignee, creator or update time. Note: GitHub's issues endpoint also returns pull requests; they are excluded by default. Use search_issues for full-text search.",
    input: z.object({
      ...repoArgs,
      state: z.enum(["open", "closed", "all"]).default("open"),
      labels: z.array(z.string()).optional().describe("Issues must have ALL these labels."),
      assignee: z.string().optional().describe("Login, 'none' or '*'."),
      creator: z.string().optional(),
      mentioned: z.string().optional(),
      milestone: z.string().optional().describe("Milestone number, '*' or 'none'."),
      since: z.string().datetime().optional().describe("Only issues updated at or after this time."),
      sort: z.enum(["created", "updated", "comments"]).default("created"),
      direction: z.enum(["asc", "desc"]).default("desc"),
      include_pull_requests: z.boolean().default(false),
      ...pagination,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/issues`, {
        state: a.state, labels: a.labels, assignee: a.assignee, creator: a.creator, mentioned: a.mentioned, milestone: a.milestone,
        since: a.since, sort: a.sort, direction: a.direction, per_page: a.per_page, page: a.page,
      });
      const filtered = a.include_pull_requests ? items : items.filter((i) => !i.pull_request);
      return { issues: filtered.map(summarizeIssue), pagination: p };
    },
  }),

  defineTool({
    name: "get_issue",
    toolset: "issues",
    title: "Get an issue",
    description: "Get an issue's full details including its body. Works for pull request numbers too (returns the conversation part). Use list_issue_comments for the discussion.",
    input: z.object({ ...repoArgs, issue_number: issueNumber }),
    readOnly: true,
    handler: async (a, { gh }) => issueDetails(await gh.get(issuePath(a.owner, a.repo, a.issue_number))),
  }),

  defineTool({
    name: "create_issue",
    toolset: "issues",
    title: "Create an issue",
    description: "Create a new issue. Labels that don't exist yet are created automatically by GitHub only if you have push access; assignees must have access to the repository.",
    input: z.object({
      ...repoArgs,
      title: z.string().min(1).max(256),
      body: z.string().max(65_536).optional().describe("Markdown description."),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).max(10).optional(),
      milestone: z.number().int().positive().optional().describe("Milestone number."),
      type: z.string().optional().describe("Issue type name (organizations with issue types only)."),
    }),
    readOnly: false,
    handler: async ({ owner, repo, ...body }, { gh }) => ({ created: true, ...issueDetails(await gh.post(`${repoPath(owner, repo)}/issues`, body)) }),
  }),

  defineTool({
    name: "update_issue",
    toolset: "issues",
    title: "Update, close or reopen an issue",
    description:
      "Edit an issue: title, body, close/reopen (state), close reason, labels (REPLACES all labels), assignees (REPLACES all) or milestone. Only fields you pass change. To add/remove single labels or assignees use the dedicated tools.",
    input: z.object({
      ...repoArgs,
      issue_number: issueNumber,
      title: z.string().min(1).max(256).optional(),
      body: z.string().max(65_536).optional(),
      state: z.enum(["open", "closed"]).optional(),
      state_reason: z.enum(["completed", "not_planned", "duplicate", "reopened"]).optional().describe("Why it was closed/reopened."),
      labels: z.array(z.string()).optional().describe("Full replacement list of labels."),
      assignees: z.array(z.string()).max(10).optional().describe("Full replacement list of assignees."),
      milestone: z.number().int().positive().nullable().optional().describe("Milestone number, or null to remove."),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, issue_number, ...changes }, { gh }) => {
      if (Object.values(changes).every((v) => v === undefined)) throw new ToolInputError("Pass at least one field to change.");
      return issueDetails(await gh.patch(issuePath(owner, repo, issue_number), changes));
    },
  }),

  defineTool({
    name: "add_issue_assignees",
    toolset: "issues",
    title: "Assign users to an issue or PR",
    description: "Add assignees to an issue or pull request (keeps existing assignees). Users without access are silently ignored by GitHub.",
    input: z.object({ ...repoArgs, issue_number: issueNumber, assignees: z.array(z.string()).min(1).max(10) }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      const i = await gh.post<Record<string, unknown>>(`${issuePath(a.owner, a.repo, a.issue_number)}/assignees`, { assignees: a.assignees });
      return { issue_number: a.issue_number, assignees: compact(i.assignees) };
    },
  }),

  defineTool({
    name: "remove_issue_assignees",
    toolset: "issues",
    title: "Unassign users from an issue or PR",
    description: "Remove assignees from an issue or pull request.",
    input: z.object({ ...repoArgs, issue_number: issueNumber, assignees: z.array(z.string()).min(1).max(10) }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      const i = await gh.delete<Record<string, unknown>>(`${issuePath(a.owner, a.repo, a.issue_number)}/assignees`, { assignees: a.assignees });
      return { issue_number: a.issue_number, assignees: compact(i.assignees) };
    },
  }),

  defineTool({
    name: "add_issue_labels",
    toolset: "issues",
    title: "Add labels to an issue or PR",
    description: "Add labels to an issue or pull request (keeps existing labels).",
    input: z.object({ ...repoArgs, issue_number: issueNumber, labels: z.array(z.string().min(1)).min(1).max(20) }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      const labels = await gh.post<Array<{ name: string }>>(`${issuePath(a.owner, a.repo, a.issue_number)}/labels`, { labels: a.labels });
      return { issue_number: a.issue_number, labels: labels.map((l) => l.name) };
    },
  }),

  defineTool({
    name: "remove_issue_label",
    toolset: "issues",
    title: "Remove a label from an issue or PR",
    description: "Remove one label from an issue or pull request.",
    input: z.object({ ...repoArgs, issue_number: issueNumber, label: z.string().min(1) }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      const labels = await gh.delete<Array<{ name: string }>>(`${issuePath(a.owner, a.repo, a.issue_number)}/labels/${enc(a.label)}`);
      return { issue_number: a.issue_number, labels: (labels ?? []).map((l) => l.name) };
    },
  }),

  defineTool({
    name: "list_issue_comments",
    toolset: "issues",
    title: "List comments on an issue or PR",
    description: "List the conversation comments on an issue or pull request (oldest first). For line-level PR comments use list_pull_request_review_comments.",
    input: z.object({ ...repoArgs, issue_number: issueNumber, since: z.string().datetime().optional(), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${issuePath(a.owner, a.repo, a.issue_number)}/comments`, { since: a.since, per_page: a.per_page, page: a.page });
      return { comments: items.map(comment), pagination: p };
    },
  }),

  defineTool({
    name: "add_issue_comment",
    toolset: "issues",
    title: "Comment on an issue or PR",
    description: "Add a comment to an issue or a pull request's conversation (use the PR number as issue_number). Markdown supported.",
    input: z.object({ ...repoArgs, issue_number: issueNumber, body: z.string().min(1).max(65_536) }),
    readOnly: false,
    handler: async (a, { gh }) => comment(await gh.post(`${issuePath(a.owner, a.repo, a.issue_number)}/comments`, { body: a.body })),
  }),

  defineTool({
    name: "update_issue_comment",
    toolset: "issues",
    title: "Edit a comment",
    description: "Replace the text of an existing issue/PR conversation comment.",
    input: z.object({ ...repoArgs, comment_id: z.number().int().positive(), body: z.string().min(1).max(65_536) }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => comment(await gh.patch(`${repoPath(a.owner, a.repo)}/issues/comments/${a.comment_id}`, { body: a.body })),
  }),

  defineTool({
    name: "delete_issue_comment",
    toolset: "issues",
    title: "Delete a comment",
    description: "Delete an issue/PR conversation comment by its comment ID (from list_issue_comments).",
    input: z.object({ ...repoArgs, comment_id: z.number().int().positive() }),
    readOnly: false,
    destructive: true,
    idempotent: true,
    handler: async (a, { gh }) => {
      await gh.delete(`${repoPath(a.owner, a.repo)}/issues/comments/${a.comment_id}`);
      return { deleted_comment: a.comment_id };
    },
  }),

  // ---- Labels ----------------------------------------------------------------

  defineTool({
    name: "list_labels",
    toolset: "issues",
    title: "List repository labels",
    description: "List the labels defined in a repository (name, color, description).",
    input: z.object({ ...repoArgs, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/labels`, { per_page: a.per_page, page: a.page });
      return { labels: items.map((l) => pick(l, ["name", "color", "description"])), pagination: p };
    },
  }),

  defineTool({
    name: "create_label",
    toolset: "issues",
    title: "Create a label",
    description: "Create a repository label that can then be added to issues and pull requests.",
    input: z.object({
      ...repoArgs,
      name: z.string().min(1).max(50),
      color: z.string().regex(/^[0-9a-fA-F]{6}$/).default("ededed").describe("6-digit hex color without '#'."),
      description: z.string().max(100).optional(),
    }),
    readOnly: false,
    handler: async ({ owner, repo, ...body }, { gh }) => pick(await gh.post(`${repoPath(owner, repo)}/labels`, body), ["name", "color", "description"]),
  }),

  defineTool({
    name: "update_label",
    toolset: "issues",
    title: "Update a label",
    description: "Rename a label or change its color/description.",
    input: z.object({
      ...repoArgs,
      name: z.string().min(1).describe("Current label name."),
      new_name: z.string().min(1).max(50).optional(),
      color: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
      description: z.string().max(100).optional(),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, name, ...body }, { gh }) => pick(await gh.patch(`${repoPath(owner, repo)}/labels/${enc(name)}`, body), ["name", "color", "description"]),
  }),

  defineTool({
    name: "delete_label",
    toolset: "issues",
    title: "Delete a label",
    description: "Delete a label from the repository (it is removed from all issues and PRs).",
    input: z.object({ ...repoArgs, name: z.string().min(1) }),
    readOnly: false,
    destructive: true,
    idempotent: true,
    handler: async (a, { gh }) => {
      await gh.delete(`${repoPath(a.owner, a.repo)}/labels/${enc(a.name)}`);
      return { deleted_label: a.name };
    },
  }),

  // ---- Milestones --------------------------------------------------------------

  defineTool({
    name: "list_milestones",
    toolset: "issues",
    title: "List milestones",
    description: "List milestones with their open/closed issue counts and due dates.",
    input: z.object({ ...repoArgs, state: z.enum(["open", "closed", "all"]).default("open"), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/milestones`, { state: a.state, per_page: a.per_page, page: a.page });
      return { milestones: items.map((m) => pick(m, ["number", "title", "state", "description", "open_issues", "closed_issues", "due_on", "html_url"])), pagination: p };
    },
  }),

  defineTool({
    name: "create_milestone",
    toolset: "issues",
    title: "Create a milestone",
    description: "Create a milestone. Assign issues to it with update_issue (milestone = number).",
    input: z.object({
      ...repoArgs,
      title: z.string().min(1).max(256),
      description: z.string().optional(),
      due_on: z.string().datetime().optional().describe("ISO 8601 timestamp, e.g. 2026-12-31T00:00:00Z."),
      state: z.enum(["open", "closed"]).default("open"),
    }),
    readOnly: false,
    handler: async ({ owner, repo, ...body }, { gh }) => pick(await gh.post(`${repoPath(owner, repo)}/milestones`, body), ["number", "title", "state", "due_on", "html_url"]),
  }),

  defineTool({
    name: "update_milestone",
    toolset: "issues",
    title: "Update or close a milestone",
    description: "Change a milestone's title, description, due date, or close/reopen it.",
    input: z.object({
      ...repoArgs,
      milestone_number: z.number().int().positive(),
      title: z.string().min(1).max(256).optional(),
      description: z.string().optional(),
      due_on: z.string().datetime().optional(),
      state: z.enum(["open", "closed"]).optional(),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, milestone_number, ...body }, { gh }) =>
      pick(await gh.patch(`${repoPath(owner, repo)}/milestones/${milestone_number}`, body), ["number", "title", "state", "due_on", "html_url"]),
  }),

  defineTool({
    name: "delete_milestone",
    toolset: "issues",
    title: "Delete a milestone",
    description: "Delete a milestone (issues keep existing but lose the milestone).",
    input: z.object({ ...repoArgs, milestone_number: z.number().int().positive() }),
    readOnly: false,
    destructive: true,
    idempotent: true,
    handler: async (a, { gh }) => {
      await gh.delete(`${repoPath(a.owner, a.repo)}/milestones/${a.milestone_number}`);
      return { deleted_milestone: a.milestone_number };
    },
  }),
];
