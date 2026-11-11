import { z } from "zod";
import { compact, summarizeCommit } from "../github/compact";
import { enc, encPath } from "../github/client";
import { GitHubApiError, ToolInputError } from "../github/errors";
import { getBranchHead, getDefaultBranch, resolveCommitSha } from "../github/gitops";
import { branch, confirmField, defineTool, pagination, repoArgs, requireConfirmation } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;

export const branchTools = [
  defineTool({
    name: "list_branches",
    toolset: "branches",
    title: "List branches",
    description: "List a repository's branches with their head commit SHA and whether they are protected.",
    input: z.object({ ...repoArgs, protected: z.boolean().optional().describe("true = only protected branches."), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<{ name: string; commit: { sha: string }; protected: boolean }>(`${repoPath(a.owner, a.repo)}/branches`, {
        protected: a.protected,
        per_page: a.per_page,
        page: a.page,
      });
      return { branches: items.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected })), pagination: p };
    },
  }),

  defineTool({
    name: "get_branch",
    toolset: "branches",
    title: "Get branch details",
    description: "Get a branch's head commit (SHA, message, author, date) and protection state.",
    input: z.object({ ...repoArgs, branch }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const b = await gh.get<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/branches/${encPath(a.branch)}`);
      return { name: b.name, protected: b.protected, head_commit: summarizeCommit(b.commit as Record<string, unknown>), protection: compact(b.protection) };
    },
  }),

  defineTool({
    name: "create_branch",
    toolset: "branches",
    title: "Create a branch",
    description:
      "Create a new branch from another branch, tag or commit (default: the repository's default branch). Example: branch 'feature/dashboard' from 'main'. Then commit to it with commit_files or create_or_update_file.",
    input: z.object({
      ...repoArgs,
      branch: branch.describe("Name of the new branch."),
      from: z.string().optional().describe("Source branch, tag or commit SHA. Default: the default branch."),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      if (!/^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[^\s~^:?*[\\\x00-\x1f\x7f]+$/.test(a.branch) || a.branch.startsWith("-")) {
        throw new ToolInputError(`'${a.branch}' is not a valid git branch name.`);
      }
      const existing = await getBranchHead(gh, a.owner, a.repo, a.branch);
      if (typeof existing === "string") throw new ToolInputError(`Branch '${a.branch}' already exists (at ${existing}).`);
      if (existing === "EMPTY_REPOSITORY") throw new ToolInputError("The repository is empty. Add a first file (create_or_update_file or commit_files) before creating branches.");
      const from = a.from ?? (await getDefaultBranch(gh, a.owner, a.repo));
      const baseSha = await resolveCommitSha(gh, a.owner, a.repo, from);
      const r = await gh.post<{ ref: string; object: { sha: string } }>(`${repoPath(a.owner, a.repo)}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: baseSha });
      return { created: a.branch, from, sha: r.object.sha };
    },
  }),

  defineTool({
    name: "rename_branch",
    toolset: "branches",
    title: "Rename a branch",
    description: "Rename a branch. GitHub also updates open pull requests and branch protection that reference it, and redirects the old name. Renaming the default branch requires admin access.",
    input: z.object({ ...repoArgs, branch: branch.describe("Current branch name."), new_name: z.string().min(1).max(255) }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const b = await gh.post<{ name: string }>(`${repoPath(a.owner, a.repo)}/branches/${encPath(a.branch)}/rename`, { new_name: a.new_name });
      return { renamed_from: a.branch, renamed_to: b.name };
    },
  }),

  defineTool({
    name: "delete_branch",
    toolset: "branches",
    title: "Delete a branch",
    description:
      "Delete a branch. Refuses to delete the default branch. Requires confirm = the branch name after explicit user approval. Commits only on that branch become unreachable (recoverable only via its last SHA, which is returned).",
    input: z.object({ ...repoArgs, branch, confirm: confirmField("the branch name") }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      const def = await getDefaultBranch(gh, a.owner, a.repo);
      if (a.branch === def) throw new ToolInputError(`'${a.branch}' is the default branch and cannot be deleted. Change the default branch first.`);
      requireConfirmation(a.confirm, a.branch, `delete branch '${a.branch}' in ${a.owner}/${a.repo}`);
      const head = await getBranchHead(gh, a.owner, a.repo, a.branch);
      if (typeof head !== "string") throw new GitHubApiError(404, `Branch '${a.branch}' not found.`, "Check the name with list_branches.");
      await gh.delete(`${repoPath(a.owner, a.repo)}/git/refs/heads/${encPath(a.branch)}`);
      return { deleted: a.branch, last_sha: head, restore_hint: `Recreate with create_branch from '${head}' if needed.` };
    },
  }),

  defineTool({
    name: "merge_branch",
    toolset: "branches",
    title: "Merge one branch into another",
    description:
      "Merge a branch/commit directly into a base branch without a pull request (creates a merge commit on base, or fast-forwards nothing if already merged). For reviewed changes prefer create_pull_request + merge_pull_request.",
    input: z.object({
      ...repoArgs,
      base: branch.describe("Branch that receives the changes."),
      head: z.string().min(1).describe("Branch or SHA to merge in."),
      commit_message: z.string().max(5000).optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const res = await gh.request<Record<string, unknown>>("POST", `${repoPath(a.owner, a.repo)}/merges`, {
        body: { base: a.base, head: a.head, commit_message: a.commit_message },
        allowStatuses: [204],
      });
      if (res.status === 204) return { merged: false, reason: `'${a.base}' already contains '${a.head}'. Nothing to merge.` };
      return { merged: true, merge_commit_sha: res.data.sha, html_url: res.data.html_url };
    },
  }),

  defineTool({
    name: "sync_fork_branch",
    toolset: "branches",
    title: "Sync a fork branch with upstream",
    description: "Update a branch of a forked repository with the latest changes from the upstream (parent) repository, like the 'Sync fork' button.",
    input: z.object({ ...repoArgs, branch }),
    readOnly: false,
    handler: async (a, { gh }) => gh.post(`${repoPath(a.owner, a.repo)}/merge-upstream`, { branch: a.branch }),
  }),

  defineTool({
    name: "get_branch_protection",
    toolset: "branches",
    title: "Get branch protection rules",
    description: "Show branch protection settings (required reviews, status checks, admin enforcement, force-push/deletion rules). Also lists repository rulesets that apply to the branch. Requires admin read access for classic protection.",
    input: z.object({ ...repoArgs, branch }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const [prot, rules] = await Promise.all([
        gh.request<Record<string, unknown>>("GET", `${repoPath(a.owner, a.repo)}/branches/${encPath(a.branch)}/protection`, { allowStatuses: [404] }),
        gh.request<Array<Record<string, unknown>>>("GET", `${repoPath(a.owner, a.repo)}/rules/branches/${encPath(a.branch)}`, { allowStatuses: [404] }),
      ]);
      const p = prot.status === 404 ? null : (compact(prot.data) as Record<string, unknown>);
      return {
        branch: a.branch,
        classic_protection: p ?? "none (or no permission to read it)",
        ruleset_rules: rules.status === 404 ? [] : (rules.data ?? []).map((r) => ({ type: r.type, parameters: r.parameters, ruleset_id: r.ruleset_id })),
      };
    },
  }),

  defineTool({
    name: "update_branch_protection",
    toolset: "branches",
    title: "Set branch protection rules",
    description:
      "Create or replace classic branch protection for a branch. The settings you pass REPLACE the existing protection entirely. Requires admin access ('Administration: write'). Not available for private repositories on GitHub Free.",
    input: z.object({
      ...repoArgs,
      branch,
      required_approving_review_count: z.number().int().min(0).max(6).optional().describe("Number of approvals required before merging. Omit to not require PR reviews."),
      dismiss_stale_reviews: z.boolean().default(false),
      require_code_owner_reviews: z.boolean().default(false),
      required_status_checks: z.array(z.string()).optional().describe("Names of status checks that must pass. Omit for none."),
      strict_status_checks: z.boolean().default(false).describe("Require branches to be up to date before merging."),
      enforce_admins: z.boolean().default(false),
      required_linear_history: z.boolean().default(false),
      allow_force_pushes: z.boolean().default(false),
      allow_deletions: z.boolean().default(false),
      required_conversation_resolution: z.boolean().default(false),
      lock_branch: z.boolean().default(false).describe("Make the branch read-only."),
    }),
    readOnly: false,
    destructive: true,
    idempotent: true,
    handler: async (a, { gh }) => {
      const body = {
        required_status_checks: a.required_status_checks ? { strict: a.strict_status_checks, contexts: a.required_status_checks } : null,
        enforce_admins: a.enforce_admins,
        required_pull_request_reviews:
          a.required_approving_review_count !== undefined
            ? { required_approving_review_count: a.required_approving_review_count, dismiss_stale_reviews: a.dismiss_stale_reviews, require_code_owner_reviews: a.require_code_owner_reviews }
            : null,
        restrictions: null,
        required_linear_history: a.required_linear_history,
        allow_force_pushes: a.allow_force_pushes,
        allow_deletions: a.allow_deletions,
        required_conversation_resolution: a.required_conversation_resolution,
        lock_branch: a.lock_branch,
      };
      const r = await gh.put(`${repoPath(a.owner, a.repo)}/branches/${encPath(a.branch)}/protection`, body);
      return { branch: a.branch, protection: compact(r) };
    },
  }),

  defineTool({
    name: "delete_branch_protection",
    toolset: "branches",
    title: "Remove branch protection",
    description: "Remove classic branch protection from a branch. Requires confirm = the branch name after explicit user approval.",
    input: z.object({ ...repoArgs, branch, confirm: confirmField("the branch name") }),
    readOnly: false,
    destructive: true,
    idempotent: true,
    handler: async (a, { gh }) => {
      requireConfirmation(a.confirm, a.branch, `remove protection from branch '${a.branch}'`);
      await gh.delete(`${repoPath(a.owner, a.repo)}/branches/${encPath(a.branch)}/protection`);
      return { unprotected: a.branch };
    },
  }),
];
