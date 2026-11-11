import { z } from "zod";
import { compact, pick, summarizeCommit, summarizePull, truncate } from "../github/compact";
import { enc } from "../github/client";
import { ToolInputError } from "../github/errors";
import { TextResult, defineTool, issueNumber, pagination, repoArgs, sha } from "./define";
import { statusAndChecks, summarizeFiles, type FileDiff } from "./git";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;
const prPath = (o: string, r: string, n: number) => `${repoPath(o, r)}/pulls/${n}`;
const pull_number = issueNumber.describe("Pull request number.");

function prDetails(pr: Record<string, unknown>) {
  const head = pr.head as Record<string, unknown>;
  const base = pr.base as Record<string, unknown>;
  const d = compact(
    pick(pr, [
      "number", "title", "body", "state", "draft", "merged", "mergeable", "mergeable_state", "rebaseable", "user", "assignees",
      "requested_reviewers", "labels", "milestone", "commits", "additions", "deletions", "changed_files", "comments", "review_comments",
      "maintainer_can_modify", "auto_merge", "merged_by", "created_at", "updated_at", "closed_at", "merged_at", "html_url",
    ]),
  ) as Record<string, unknown>;
  if (Array.isArray(d.labels)) d.labels = (d.labels as Array<Record<string, unknown>>).map((l) => l.name);
  if (d.milestone && typeof d.milestone === "object") d.milestone = (d.milestone as Record<string, unknown>).title;
  d.head = { ref: head.ref, sha: head.sha, repo: (head.repo as Record<string, unknown> | null)?.full_name };
  d.base = { ref: base.ref, sha: base.sha, repo: (base.repo as Record<string, unknown> | null)?.full_name };
  return d;
}

export const pullTools = [
  defineTool({
    name: "list_pull_requests",
    toolset: "pulls",
    title: "List pull requests",
    description: "List pull requests in a repository, filtered by state, base branch or head branch. Use search_pull_requests for author/label/text filters across repositories.",
    input: z.object({
      ...repoArgs,
      state: z.enum(["open", "closed", "all"]).default("open"),
      base: z.string().optional().describe("Only PRs targeting this base branch."),
      head: z.string().optional().describe("Only PRs from this head, formatted 'user:branch' or 'org:branch'."),
      sort: z.enum(["created", "updated", "popularity", "long-running"]).default("created"),
      direction: z.enum(["asc", "desc"]).default("desc"),
      ...pagination,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/pulls`, {
        state: a.state, base: a.base, head: a.head, sort: a.sort, direction: a.direction, per_page: a.per_page, page: a.page,
      });
      return { pull_requests: items.map(summarizePull), pagination: p };
    },
  }),

  defineTool({
    name: "get_pull_request",
    toolset: "pulls",
    title: "Get pull request details",
    description: "Get a pull request's description, state, head/base branches and SHAs, mergeability, review requests and change stats.",
    input: z.object({ ...repoArgs, pull_number }),
    readOnly: true,
    handler: async (a, { gh }) => prDetails(await gh.get(prPath(a.owner, a.repo, a.pull_number))),
  }),

  defineTool({
    name: "create_pull_request",
    toolset: "pulls",
    title: "Create a pull request",
    description:
      "Open a pull request to merge 'head' into 'base' (e.g. head 'feature/dashboard' into base 'main'). The head branch must already contain commits not in base. For a fork, use head 'username:branch'.",
    input: z.object({
      ...repoArgs,
      title: z.string().min(1).max(256),
      head: z.string().min(1).describe("Branch with the changes (or 'user:branch' for forks)."),
      base: z.string().min(1).describe("Branch to merge into, e.g. 'main'."),
      body: z.string().max(65_536).optional().describe("Description in Markdown. 'Closes #12' links issues."),
      draft: z.boolean().default(false),
      maintainer_can_modify: z.boolean().default(true),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const pr = await gh.post<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/pulls`, {
        title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft, maintainer_can_modify: a.maintainer_can_modify,
      });
      return { created: true, ...prDetails(pr) };
    },
  }),

  defineTool({
    name: "update_pull_request",
    toolset: "pulls",
    title: "Update, close or reopen a pull request",
    description: "Edit a pull request's title, body or base branch, or close (state 'closed') / reopen (state 'open') it. Only the fields you pass are changed.",
    input: z.object({
      ...repoArgs,
      pull_number,
      title: z.string().min(1).max(256).optional(),
      body: z.string().max(65_536).optional(),
      state: z.enum(["open", "closed"]).optional().describe("'closed' closes without merging; 'open' reopens."),
      base: z.string().optional().describe("Change the target branch."),
      maintainer_can_modify: z.boolean().optional(),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, pull_number, ...changes }, { gh }) => {
      if (Object.values(changes).every((v) => v === undefined)) throw new ToolInputError("Pass at least one field to change.");
      return prDetails(await gh.patch(prPath(owner, repo, pull_number), changes));
    },
  }),

  defineTool({
    name: "merge_pull_request",
    toolset: "pulls",
    title: "Merge a pull request",
    description:
      "Merge a pull request using 'merge', 'squash' or 'rebase'. Pass sha (the PR head SHA you reviewed) to make sure no new commits are merged unexpectedly. Fails if checks/reviews required by branch protection are not satisfied or there are conflicts.",
    input: z.object({
      ...repoArgs,
      pull_number,
      merge_method: z.enum(["merge", "squash", "rebase"]).default("merge"),
      commit_title: z.string().max(256).optional(),
      commit_message: z.string().max(65_536).optional(),
      sha: sha.optional().describe("Expected head SHA; merge fails if the PR head differs."),
      delete_branch_after_merge: z.boolean().default(false).describe("Delete the head branch afterwards (same repository only)."),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const res = await gh.put<{ merged: boolean; sha: string; message: string }>(`${prPath(a.owner, a.repo, a.pull_number)}/merge`, {
        merge_method: a.merge_method, commit_title: a.commit_title, commit_message: a.commit_message, sha: a.sha,
      });
      let branchDeleted: string | undefined;
      if (res.merged && a.delete_branch_after_merge) {
        const pr = await gh.get<Record<string, unknown>>(prPath(a.owner, a.repo, a.pull_number));
        const head = pr.head as Record<string, unknown>;
        const headRepo = (head.repo as Record<string, unknown> | null)?.full_name;
        if (headRepo === `${a.owner}/${a.repo}`) {
          await gh.request("DELETE", `${repoPath(a.owner, a.repo)}/git/refs/heads/${String(head.ref).split("/").map(encodeURIComponent).join("/")}`, { allowStatuses: [422] });
          branchDeleted = String(head.ref);
        }
      }
      return { merged: res.merged, merge_commit_sha: res.sha, message: res.message, ...(branchDeleted && { deleted_branch: branchDeleted }) };
    },
  }),

  defineTool({
    name: "get_pull_request_diff",
    toolset: "pulls",
    title: "Get a pull request's diff",
    description: "Get the complete unified diff of a pull request as text (truncated for very large PRs; use list_pull_request_files for per-file patches).",
    input: z.object({ ...repoArgs, pull_number, max_chars: z.number().int().min(1000).max(400_000).default(80_000) }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const diff = await gh.get<string>(prPath(a.owner, a.repo, a.pull_number), undefined, { accept: "application/vnd.github.diff", responseType: "text" });
      const t = truncate(diff, a.max_chars);
      return new TextResult(t.text || "(empty diff)", { pull_number: a.pull_number, truncated: t.truncated, total_chars: diff.length });
    },
  }),

  defineTool({
    name: "list_pull_request_files",
    toolset: "pulls",
    title: "List files changed in a pull request",
    description: "List the files a pull request changes with additions/deletions and optional per-file patches.",
    input: z.object({ ...repoArgs, pull_number, include_patch: z.boolean().default(true), max_patch_chars: z.number().int().min(1000).max(400_000).default(60_000), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<FileDiff>(`${prPath(a.owner, a.repo, a.pull_number)}/files`, { per_page: a.per_page, page: a.page });
      return { files: summarizeFiles(items, a.include_patch, a.max_patch_chars), pagination: p };
    },
  }),

  defineTool({
    name: "list_pull_request_commits",
    toolset: "pulls",
    title: "List commits in a pull request",
    description: "List the commits included in a pull request (oldest first).",
    input: z.object({ ...repoArgs, pull_number, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${prPath(a.owner, a.repo, a.pull_number)}/commits`, { per_page: a.per_page, page: a.page });
      return { commits: items.map(summarizeCommit), pagination: p };
    },
  }),

  defineTool({
    name: "get_pull_request_checks",
    toolset: "pulls",
    title: "Get CI checks for a pull request",
    description: "Get the CI status (check runs and commit statuses) for a pull request's latest head commit, with an overall passing/failing/pending verdict.",
    input: z.object({ ...repoArgs, pull_number }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const pr = await gh.get<Record<string, unknown>>(prPath(a.owner, a.repo, a.pull_number));
      const headSha = String((pr.head as Record<string, unknown>).sha);
      return { pull_number: a.pull_number, mergeable_state: pr.mergeable_state, ...(await statusAndChecks(gh, a.owner, a.repo, headSha)) };
    },
  }),

  defineTool({
    name: "create_pull_request_review",
    toolset: "pulls",
    title: "Review a pull request",
    description:
      "Submit a review: APPROVE, REQUEST_CHANGES (body required) or COMMENT, optionally with inline comments on specific lines. Line numbers refer to the file in the PR's head version ('RIGHT' side) unless side is 'LEFT'. You cannot approve your own pull request.",
    input: z.object({
      ...repoArgs,
      pull_number,
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      body: z.string().max(65_536).optional().describe("Overall review comment (required for REQUEST_CHANGES and COMMENT without inline comments)."),
      commit_id: sha.optional().describe("Commit to review. Default: the PR's latest commit."),
      comments: z
        .array(
          z.object({
            path: z.string().min(1).describe("File path in the PR."),
            line: z.number().int().min(1).describe("Line number (last line for multi-line comments)."),
            start_line: z.number().int().min(1).optional().describe("First line for a multi-line comment."),
            side: z.enum(["LEFT", "RIGHT"]).default("RIGHT").describe("RIGHT = new version, LEFT = old version."),
            body: z.string().min(1).describe("Comment text. Use a ```suggestion block to propose a change."),
          }),
        )
        .max(50)
        .optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      if (a.event === "REQUEST_CHANGES" && !a.body) throw new ToolInputError("REQUEST_CHANGES needs a body explaining what to change.");
      if (a.event === "COMMENT" && !a.body && !a.comments?.length) throw new ToolInputError("A COMMENT review needs a body or inline comments.");
      const comments = a.comments?.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body, ...(c.start_line && { start_line: c.start_line, start_side: c.side }) }));
      const r = await gh.post<Record<string, unknown>>(`${prPath(a.owner, a.repo, a.pull_number)}/reviews`, { event: a.event, body: a.body, commit_id: a.commit_id, comments });
      return { review_id: r.id, state: r.state, html_url: r.html_url };
    },
  }),

  defineTool({
    name: "list_pull_request_reviews",
    toolset: "pulls",
    title: "List pull request reviews",
    description: "List the review history of a pull request: who approved, requested changes or commented, and when.",
    input: z.object({ ...repoArgs, pull_number, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${prPath(a.owner, a.repo, a.pull_number)}/reviews`, { per_page: a.per_page, page: a.page });
      return { reviews: items.map((r) => compact(pick(r, ["id", "user", "state", "body", "submitted_at", "commit_id", "html_url"]))), pagination: p };
    },
  }),

  defineTool({
    name: "list_pull_request_review_comments",
    toolset: "pulls",
    title: "List inline review comments",
    description: "List inline (line-level) review comments on a pull request, including the file path, line and the comment thread they belong to.",
    input: z.object({ ...repoArgs, pull_number, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${prPath(a.owner, a.repo, a.pull_number)}/comments`, { per_page: a.per_page, page: a.page });
      return {
        comments: items.map((c) => compact(pick(c, ["id", "in_reply_to_id", "user", "path", "line", "start_line", "side", "body", "diff_hunk", "created_at", "html_url"]))),
        pagination: p,
      };
    },
  }),

  defineTool({
    name: "add_pull_request_review_comment",
    toolset: "pulls",
    title: "Add an inline review comment",
    description: "Add a single inline comment on a line of a pull request's diff, or reply to an existing review comment (in_reply_to). For general (non-line) comments use add_issue_comment with the PR number.",
    input: z.object({
      ...repoArgs,
      pull_number,
      body: z.string().min(1).max(65_536),
      in_reply_to: z.number().int().positive().optional().describe("ID of a review comment to reply to. If set, path/line are ignored."),
      path: z.string().optional().describe("File path (required unless replying)."),
      line: z.number().int().min(1).optional().describe("Line in the file (required unless replying)."),
      start_line: z.number().int().min(1).optional(),
      side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
      commit_id: sha.optional().describe("Default: the PR's latest commit."),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      if (a.in_reply_to) {
        const r = await gh.post<Record<string, unknown>>(`${prPath(a.owner, a.repo, a.pull_number)}/comments/${a.in_reply_to}/replies`, { body: a.body });
        return { comment_id: r.id, html_url: r.html_url };
      }
      if (!a.path || !a.line) throw new ToolInputError("path and line are required for a new inline comment.");
      let commitId = a.commit_id;
      if (!commitId) {
        const pr = await gh.get<Record<string, unknown>>(prPath(a.owner, a.repo, a.pull_number));
        commitId = String((pr.head as Record<string, unknown>).sha);
      }
      const r = await gh.post<Record<string, unknown>>(`${prPath(a.owner, a.repo, a.pull_number)}/comments`, {
        body: a.body, commit_id: commitId, path: a.path, line: a.line, side: a.side, ...(a.start_line && { start_line: a.start_line, start_side: a.side }),
      });
      return { comment_id: r.id, html_url: r.html_url };
    },
  }),

  defineTool({
    name: "request_pull_request_reviewers",
    toolset: "pulls",
    title: "Request reviewers",
    description: "Request reviews on a pull request from users and/or teams (team slugs).",
    input: z.object({ ...repoArgs, pull_number, reviewers: z.array(z.string()).max(15).default([]), team_reviewers: z.array(z.string()).max(15).default([]) }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      if (!a.reviewers.length && !a.team_reviewers.length) throw new ToolInputError("Give at least one reviewer or team.");
      const r = await gh.post<Record<string, unknown>>(`${prPath(a.owner, a.repo, a.pull_number)}/requested_reviewers`, { reviewers: a.reviewers, team_reviewers: a.team_reviewers });
      return { requested_reviewers: compact(r.requested_reviewers), requested_teams: ((r.requested_teams as Array<Record<string, unknown>>) ?? []).map((t) => t.slug) };
    },
  }),

  defineTool({
    name: "update_pull_request_branch",
    toolset: "pulls",
    title: "Update a PR branch with its base",
    description: "Merge the latest base branch into the pull request's head branch (the 'Update branch' button). Asynchronous on GitHub.",
    input: z.object({ ...repoArgs, pull_number, expected_head_sha: sha.optional() }),
    readOnly: false,
    handler: async (a, { gh }) => gh.put(`${prPath(a.owner, a.repo, a.pull_number)}/update-branch`, { expected_head_sha: a.expected_head_sha }),
  }),

  defineTool({
    name: "set_pull_request_draft",
    toolset: "pulls",
    title: "Mark PR ready for review or draft",
    description: "Mark a draft pull request as ready for review (draft: false), or convert a pull request back to a draft (draft: true). Uses GitHub GraphQL.",
    input: z.object({ ...repoArgs, pull_number, draft: z.boolean() }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      const pr = await gh.get<Record<string, unknown>>(prPath(a.owner, a.repo, a.pull_number));
      if (Boolean(pr.draft) === a.draft) return { pull_number: a.pull_number, draft: a.draft, changed: false };
      const mutation = a.draft
        ? "mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest { isDraft } } }"
        : "mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest { isDraft } } }";
      await gh.graphql(mutation, { id: pr.node_id });
      return { pull_number: a.pull_number, draft: a.draft, changed: true };
    },
  }),
];

