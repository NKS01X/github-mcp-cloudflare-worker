import { z } from "zod";
import { compact, summarizeCommit, truncate } from "../github/compact";
import { enc, encPath, type GitHubClient } from "../github/client";
import { base64ToBytes, decodeIfText, isValidBase64 } from "../github/encoding";
import { GitHubApiError, ToolInputError, UnsupportedOperationError } from "../github/errors";
import { commitTreeChanges, getBranchHead, getDefaultBranch, getTreeMap, type TreeChange } from "../github/gitops";
import { TextResult, branch, confirmField, defineTool, pagination, ref, repoArgs, requireConfirmation, sha } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;

export interface FileDiff {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  previous_filename?: string;
  patch?: string;
}

export function summarizeFiles(files: FileDiff[] = [], includePatch: boolean, maxPatchChars: number) {
  let budget = maxPatchChars;
  return files.map((f) => {
    const out: Record<string, unknown> = { filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
    if (f.previous_filename) out.previous_filename = f.previous_filename;
    if (includePatch) {
      if (!f.patch) out.patch = f.changes > 0 ? "(no patch: binary or too large)" : "";
      else if (budget <= 0) out.patch = "(omitted: patch budget exhausted; request this file individually)";
      else {
        const t = truncate(f.patch, budget);
        out.patch = t.text;
        budget -= f.patch.length;
      }
    }
    return out;
  });
}

const diffFormat = z
  .enum(["summary", "patch", "raw_diff"])
  .default("patch")
  .describe("'summary' = changed files with line counts; 'patch' = plus per-file unified diffs; 'raw_diff' = one complete git diff as text.");

function normalizeRef(r: string): string {
  const s = r.replace(/^refs\//, "");
  if (!/^(heads|tags|notes|pull)\/.+/.test(s)) throw new ToolInputError(`Ref must look like 'heads/<branch>' or 'tags/<tag>' (got '${r}').`);
  return s;
}

export async function statusAndChecks(gh: GitHubClient, owner: string, repo: string, refName: string) {
  const [combined, checksRes] = await Promise.all([
    gh.get<{ state: string; statuses: Array<Record<string, unknown>>; sha: string }>(`${repoPath(owner, repo)}/commits/${encPath(refName)}/status`, { per_page: 100 }),
    // Check runs need the "Checks" permission, which some token types cannot grant; degrade gracefully.
    gh.request<{ total_count: number; check_runs: Array<Record<string, unknown>> }>("GET", `${repoPath(owner, repo)}/commits/${encPath(refName)}/check-runs`, {
      query: { per_page: 100 },
      allowStatuses: [403],
    }),
  ]);
  const checksUnavailable = checksRes.status === 403;
  const checks = checksUnavailable ? { total_count: 0, check_runs: [] } : checksRes.data;
  const runs = checks.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, started_at: c.started_at, completed_at: c.completed_at, details_url: c.details_url ?? c.html_url }));
  const failing = runs.filter((r) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(String(r.conclusion)));
  const pending = runs.filter((r) => r.status !== "completed");
  return {
    sha: combined.sha,
    overall:
      failing.length > 0 || combined.state === "failure" || combined.state === "error"
        ? "failing"
        : pending.length > 0 || (combined.state === "pending" && combined.statuses.length > 0)
          ? "pending"
          : "passing",
    commit_statuses: combined.statuses.map((s) => ({ context: s.context, state: s.state, description: s.description, target_url: s.target_url })),
    check_runs: runs,
    failing_checks: failing.map((f) => f.name),
    ...(checksUnavailable && { note: "Check runs could not be read with this token (missing 'Checks: read'); only commit statuses are shown." }),
  };
}

export const gitTools = [
  defineTool({
    name: "list_commits",
    toolset: "git",
    title: "List commits",
    description: "List commits on a branch (default: default branch), newest first. Filter by file path, author, or date range. Use this for 'show me the latest commits' or a branch's history.",
    input: z.object({
      ...repoArgs,
      ref: ref.optional().describe("Branch, tag or SHA to start from. Default: default branch."),
      path: z.string().optional().describe("Only commits touching this path."),
      author: z.string().optional().describe("GitHub login or email."),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      ...pagination,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/commits`, {
        sha: a.ref,
        path: a.path,
        author: a.author,
        since: a.since,
        until: a.until,
        per_page: a.per_page,
        page: a.page,
      });
      return { commits: items.map(summarizeCommit), pagination: p };
    },
  }),

  defineTool({
    name: "get_commit",
    toolset: "git",
    title: "Get commit details and diff",
    description: "Get a commit's message, author, parents, stats and changed files with diffs. Use diff_format 'raw_diff' for a single unified diff.",
    input: z.object({
      ...repoArgs,
      ref: z.string().min(1).describe("Commit SHA, branch or tag."),
      diff_format: diffFormat,
      max_patch_chars: z.number().int().min(1000).max(400_000).default(60_000),
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const path = `${repoPath(a.owner, a.repo)}/commits/${encPath(a.ref)}`;
      if (a.diff_format === "raw_diff") {
        const diff = await gh.get<string>(path, undefined, { accept: "application/vnd.github.diff", responseType: "text" });
        const t = truncate(diff, a.max_patch_chars);
        return new TextResult(t.text, { ref: a.ref, truncated: t.truncated });
      }
      const c = await gh.get<Record<string, unknown>>(path);
      const commit = c.commit as Record<string, unknown>;
      return {
        sha: c.sha,
        message: commit.message,
        author: compact(commit.author),
        committer: compact(commit.committer),
        github_author: (c.author as Record<string, unknown> | null)?.login,
        parents: (c.parents as Array<{ sha: string }>).map((p) => p.sha),
        verified: (commit.verification as Record<string, unknown> | undefined)?.verified,
        stats: c.stats,
        files: summarizeFiles(c.files as FileDiff[], a.diff_format === "patch", a.max_patch_chars),
        html_url: c.html_url,
      };
    },
  }),

  defineTool({
    name: "compare_branches_or_commits",
    toolset: "git",
    title: "Compare branches, tags or commits",
    description:
      "Compare two refs (branches, tags or SHAs): shows whether head is ahead/behind base, the commits in head not in base, and the changed files/diff. Example: base 'main', head 'feature/dashboard'. For a fork use head 'otheruser:branch'.",
    input: z.object({
      ...repoArgs,
      base: z.string().min(1).describe("Base ref, e.g. 'main'."),
      head: z.string().min(1).describe("Head ref to compare against base, e.g. 'feature/dashboard'."),
      diff_format: diffFormat,
      max_patch_chars: z.number().int().min(1000).max(400_000).default(60_000),
      max_commits: z.number().int().min(0).max(250).default(50),
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const path = `${repoPath(a.owner, a.repo)}/compare/${encPath(a.base)}...${encPath(a.head)}`;
      if (a.diff_format === "raw_diff") {
        const diff = await gh.get<string>(path, undefined, { accept: "application/vnd.github.diff", responseType: "text" });
        const t = truncate(diff, a.max_patch_chars);
        return new TextResult(t.text || "(no differences)", { base: a.base, head: a.head, truncated: t.truncated });
      }
      const c = await gh.get<Record<string, unknown>>(path, { per_page: 100 });
      const commits = (c.commits as Array<Record<string, unknown>>) ?? [];
      return {
        base: a.base,
        head: a.head,
        status: c.status,
        ahead_by: c.ahead_by,
        behind_by: c.behind_by,
        total_commits: c.total_commits,
        merge_base_sha: (c.merge_base_commit as Record<string, unknown> | undefined)?.sha,
        commits: commits.slice(-a.max_commits).map(summarizeCommit),
        files_changed: ((c.files as unknown[]) ?? []).length,
        files: summarizeFiles(c.files as FileDiff[], a.diff_format === "patch", a.max_patch_chars),
        html_url: c.html_url,
      };
    },
  }),

  defineTool({
    name: "revert_commit",
    toolset: "git",
    title: "Revert a commit",
    description:
      "Create a new commit that undoes a previous (non-merge) commit, like 'git revert', and push it to a branch (or to a new branch for a pull request). Refuses — without changing anything — if any affected file was modified again after that commit (a conflict that needs manual resolution).",
    input: z.object({
      ...repoArgs,
      commit_sha: sha.describe("The commit to revert."),
      branch: branch.optional().describe("Branch containing the commit, where the revert is applied. Default: default branch."),
      new_branch: z.string().optional().describe("Put the revert commit on this NEW branch (created from 'branch') instead, e.g. for a pull request."),
      message: z.string().max(5000).optional().describe("Commit message. Default: 'Revert \"<original title>\"'."),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const target = await gh.get<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/commits/${enc(a.commit_sha)}`);
      const parents = target.parents as Array<{ sha: string }>;
      if (parents.length !== 1) {
        throw new UnsupportedOperationError(
          parents.length === 0 ? "Cannot revert the root commit of a repository." : "Reverting merge commits is not supported through the GitHub API. Revert the pull request on github.com (Revert button) or revert its individual commits.",
        );
      }
      const files = (target.files as FileDiff[]) ?? [];
      if (files.length >= 300) throw new UnsupportedOperationError("This commit changes 300+ files; GitHub's API does not list them all, so it cannot be reverted safely here.");

      const branchName = a.branch ?? (await getDefaultBranch(gh, a.owner, a.repo));
      const head = await getBranchHead(gh, a.owner, a.repo, branchName);
      if (typeof head !== "string") throw new GitHubApiError(404, `Branch '${branchName}' not found.`, "Check the branch name.");

      const [headTree, parentTree, targetTree] = await Promise.all([
        getTreeMap(gh, a.owner, a.repo, head),
        getTreeMap(gh, a.owner, a.repo, parents[0].sha),
        getTreeMap(gh, a.owner, a.repo, String(target.sha)),
      ]);
      if (headTree.truncated || parentTree.truncated || targetTree.truncated) {
        throw new UnsupportedOperationError("Repository tree is too large for an API-based revert (GitHub truncated the tree).");
      }

      const paths = new Set<string>();
      for (const f of files) {
        paths.add(f.filename);
        if (f.previous_filename) paths.add(f.previous_filename);
      }
      const conflicts: string[] = [];
      const changes: TreeChange[] = [];
      for (const p of paths) {
        const atTarget = targetTree.entries.get(p);
        const atHead = headTree.entries.get(p);
        const atParent = parentTree.entries.get(p);
        if (atTarget?.sha !== atHead?.sha) {
          conflicts.push(p);
          continue;
        }
        if (atParent?.sha === atTarget?.sha) continue;
        changes.push(atParent ? { path: p, sha: atParent.sha, mode: atParent.mode as TreeChange["mode"] } : { path: p, sha: null });
      }
      if (conflicts.length > 0) {
        throw new GitHubApiError(
          409,
          `Cannot revert automatically: ${conflicts.length} file(s) changed after this commit: ${conflicts.slice(0, 20).join(", ")}`,
          "Nothing was changed. Revert manually: read the current files, apply the inverse of the commit's diff (get_commit), and commit with commit_files.",
          { conflicting_files: conflicts },
        );
      }
      if (changes.length === 0) throw new ToolInputError("Nothing to revert: the branch already matches the state before this commit.");

      const commitMsg = (target.commit as Record<string, unknown>).message as string;
      const result = await commitTreeChanges(gh, {
        owner: a.owner,
        repo: a.repo,
        branch: a.new_branch ?? branchName,
        createBranchFrom: a.new_branch ? head : undefined,
        expectedHeadSha: a.new_branch ? undefined : head,
        message: a.message ?? `Revert "${commitMsg.split("\n")[0]}"\n\nThis reverts commit ${target.sha}.`,
        changes,
      });
      return { reverted_commit: target.sha, ...result };
    },
  }),

  defineTool({
    name: "get_commit_status_checks",
    toolset: "git",
    title: "Get CI status and checks for a commit",
    description: "Get the combined CI result for a commit/branch: commit statuses and GitHub check runs (Actions etc.) with an overall passing/failing/pending verdict.",
    input: z.object({ ...repoArgs, ref: z.string().min(1).describe("Commit SHA, branch or tag.") }),
    readOnly: true,
    handler: async (a, { gh }) => statusAndChecks(gh, a.owner, a.repo, a.ref),
  }),

  // ---- Git references -------------------------------------------------------

  defineTool({
    name: "list_refs",
    toolset: "git",
    title: "List git references",
    description: "List git references matching a prefix, e.g. 'heads/' (all branches), 'heads/feature/' or 'tags/v1.'.",
    input: z.object({ ...repoArgs, prefix: z.string().default("heads/").describe("Ref prefix without 'refs/', e.g. 'heads/', 'tags/'.") }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const prefix = a.prefix.replace(/^refs\//, "");
      const refs = await gh.get<Array<{ ref: string; object: { sha: string; type: string } }>>(`${repoPath(a.owner, a.repo)}/git/matching-refs/${encPath(prefix)}`);
      return { count: refs.length, refs: refs.slice(0, 1000).map((r) => ({ ref: r.ref, sha: r.object.sha, type: r.object.type })) };
    },
  }),

  defineTool({
    name: "get_ref",
    toolset: "git",
    title: "Get a git reference",
    description: "Get what a single reference points to, e.g. 'heads/main' or 'tags/v1.0.0'. For annotated tags the object type is 'tag'.",
    input: z.object({ ...repoArgs, ref: z.string().min(1).describe("e.g. 'heads/main' or 'tags/v1.0.0'.") }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const r = await gh.get<{ ref: string; object: { sha: string; type: string } }>(`${repoPath(a.owner, a.repo)}/git/ref/${encPath(normalizeRef(a.ref))}`);
      return { ref: r.ref, sha: r.object.sha, type: r.object.type };
    },
  }),

  defineTool({
    name: "create_ref",
    toolset: "git",
    title: "Create a git reference",
    description: "Create a branch or tag reference pointing at a commit SHA. Prefer create_branch / create_tag for normal use.",
    input: z.object({ ...repoArgs, ref: z.string().min(1).describe("e.g. 'heads/my-branch' or 'tags/v1.0.0'."), sha }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const r = await gh.post<{ ref: string; object: { sha: string } }>(`${repoPath(a.owner, a.repo)}/git/refs`, { ref: `refs/${normalizeRef(a.ref)}`, sha: a.sha });
      return { created: r.ref, sha: r.object.sha };
    },
  }),

  defineTool({
    name: "update_ref",
    toolset: "git",
    title: "Move a git reference",
    description:
      "Point a branch/tag reference at another commit. This is how a low-level commit created with create_git_commit is pushed. Fast-forward only by default; force: true (which can discard commits) requires confirm = the ref name.",
    input: z.object({
      ...repoArgs,
      ref: z.string().min(1).describe("e.g. 'heads/main'."),
      sha,
      force: z.boolean().default(false).describe("Allow non-fast-forward updates (rewrites history)."),
      confirm: confirmField("the ref name, e.g. 'heads/main' (only needed with force: true)"),
    }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      const r = normalizeRef(a.ref);
      if (a.force) requireConfirmation(a.confirm, r, `force-update ${r} (commits not reachable from ${a.sha} will be lost from this branch)`);
      const res = await gh.patch<{ ref: string; object: { sha: string } }>(`${repoPath(a.owner, a.repo)}/git/refs/${encPath(r)}`, { sha: a.sha, force: a.force });
      return { updated: res.ref, sha: res.object.sha, forced: a.force };
    },
  }),

  defineTool({
    name: "delete_ref",
    toolset: "git",
    title: "Delete a git reference",
    description: "Delete a branch or tag reference. Requires confirm = the ref name (e.g. 'tags/v0.1') after explicit user approval. Use delete_branch for branches.",
    input: z.object({ ...repoArgs, ref: z.string().min(1), confirm: confirmField("the ref name, e.g. 'tags/v0.1'") }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      const r = normalizeRef(a.ref);
      requireConfirmation(a.confirm, r, `delete reference ${r}`);
      await gh.delete(`${repoPath(a.owner, a.repo)}/git/refs/${encPath(r)}`);
      return { deleted: r };
    },
  }),

  // ---- Blobs, trees, low-level commits ---------------------------------------

  defineTool({
    name: "get_blob",
    toolset: "git",
    title: "Get a git blob",
    description: "Read a git blob (file content) by its SHA. Text is returned decoded; binary as base64 (up to 1 MB).",
    input: z.object({ ...repoArgs, sha, max_chars: z.number().int().min(1000).max(500_000).default(100_000) }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const b = await gh.get<{ sha: string; size: number; content: string; encoding: string }>(`${repoPath(a.owner, a.repo)}/git/blobs/${enc(a.sha)}`);
      const bytes = b.encoding === "base64" ? base64ToBytes(b.content) : new TextEncoder().encode(b.content);
      const d = decodeIfText(bytes);
      if (d.isText) {
        const t = truncate(d.text, a.max_chars);
        return new TextResult(`sha: ${b.sha}\nsize: ${b.size}\n--- blob content ---\n${t.text}`, { sha: b.sha, size: b.size, truncated: t.truncated });
      }
      if (b.size > 1_000_000) return { sha: b.sha, size: b.size, binary: true, note: "Binary blob larger than 1 MB; content omitted." };
      return { sha: b.sha, size: b.size, binary: true, content_base64: b.content.replace(/\s+/g, "") };
    },
  }),

  defineTool({
    name: "create_blob",
    toolset: "git",
    title: "Create a git blob",
    description: "Low-level: store file content as a git blob and get its SHA, for use with create_tree. Most edits should use commit_files instead.",
    input: z.object({ ...repoArgs, content: z.string().max(10_000_000), encoding: z.enum(["utf-8", "base64"]).default("utf-8") }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      if (a.encoding === "base64" && !isValidBase64(a.content)) throw new ToolInputError("content is not valid base64.");
      return gh.post<{ sha: string }>(`${repoPath(a.owner, a.repo)}/git/blobs`, { content: a.content, encoding: a.encoding });
    },
  }),

  defineTool({
    name: "get_tree",
    toolset: "git",
    title: "Get a git tree",
    description: "Read a git tree object by tree SHA, commit SHA or branch name. Set recursive to include all sub-directories.",
    input: z.object({ ...repoArgs, tree: z.string().min(1).describe("Tree SHA, commit SHA or branch/tag name."), recursive: z.boolean().default(false), max_entries: z.number().int().min(1).max(5000).default(1000) }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const t = await gh.get<{ sha: string; tree: Array<Record<string, unknown>>; truncated: boolean }>(`${repoPath(a.owner, a.repo)}/git/trees/${encPath(a.tree)}`, {
        recursive: a.recursive ? 1 : undefined,
      });
      return {
        sha: t.sha,
        truncated: t.truncated || t.tree.length > a.max_entries,
        count: t.tree.length,
        tree: t.tree.slice(0, a.max_entries).map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, size: e.size })),
      };
    },
  }),

  defineTool({
    name: "create_tree",
    toolset: "git",
    title: "Create a git tree",
    description:
      "Low-level: create a tree object. With base_tree, entries modify that tree (set sha null to delete a path). Then use create_git_commit and update_ref. Most edits should use commit_files instead.",
    input: z.object({
      ...repoArgs,
      base_tree: sha.optional().describe("Tree SHA to start from."),
      entries: z
        .array(
          z.object({
            path: z.string().min(1),
            mode: z.enum(["100644", "100755", "040000", "160000", "120000"]).default("100644"),
            type: z.enum(["blob", "tree", "commit"]).default("blob"),
            sha: z.string().nullable().optional().describe("Object SHA, or null to delete the path."),
            content: z.string().optional().describe("UTF-8 content (instead of sha)."),
          }),
        )
        .min(1)
        .max(1000),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      for (const e of a.entries) {
        if (e.content === undefined && e.sha === undefined) throw new ToolInputError(`Entry '${e.path}' needs sha, content, or sha: null.`);
      }
      const t = await gh.post<{ sha: string; truncated: boolean }>(`${repoPath(a.owner, a.repo)}/git/trees`, { base_tree: a.base_tree, tree: a.entries });
      return { tree_sha: t.sha };
    },
  }),

  defineTool({
    name: "create_git_commit",
    toolset: "git",
    title: "Create a git commit object",
    description:
      "Low-level: create a commit object from a tree SHA and parent SHAs. This does NOT move any branch — call update_ref afterwards to push it. Most edits should use commit_files instead.",
    input: z.object({
      ...repoArgs,
      message: z.string().min(1).max(10_000),
      tree: sha.describe("Tree SHA from create_tree."),
      parents: z.array(sha).max(10).describe("Parent commit SHA(s). Usually the current branch head."),
      author_name: z.string().optional(),
      author_email: z.string().email().optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const author = a.author_name && a.author_email ? { name: a.author_name, email: a.author_email } : undefined;
      const c = await gh.post<{ sha: string; html_url: string }>(`${repoPath(a.owner, a.repo)}/git/commits`, { message: a.message, tree: a.tree, parents: a.parents, author });
      return { commit_sha: c.sha, html_url: c.html_url, note: "Not on any branch yet. Use update_ref (e.g. ref 'heads/main') to push it." };
    },
  }),
];
