/**
 * Commit/push building blocks implemented with GitHub's Git Data API.
 *
 * There is no `git` binary on Workers. Instead a commit is created the same
 * way git does it internally: blobs -> tree -> commit -> move the branch ref.
 * Moving the ref IS the push: the branch on GitHub changes immediately.
 */
import { GitHubApiError, ToolInputError, hintForStatus } from "./errors";
import { enc, encPath, type GitHubClient } from "./client";
import { utf8ToBase64 } from "./encoding";

export type FileMode = "100644" | "100755" | "040000" | "160000" | "120000";

export interface TreeChange {
  path: string;
  mode?: FileMode;
  /** UTF-8 text content (GitHub creates the blob). */
  content?: string;
  /** Existing blob SHA, or null to delete the path. */
  sha?: string | null;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}

export async function getDefaultBranch(gh: GitHubClient, owner: string, repo: string): Promise<string> {
  const r = await gh.get<{ default_branch: string }>(repoPath(owner, repo));
  return r.default_branch;
}

/** Returns the commit SHA a branch points at, or undefined if the branch does not exist. Throws "empty" marker for empty repos. */
export async function getBranchHead(gh: GitHubClient, owner: string, repo: string, branch: string): Promise<string | undefined | "EMPTY_REPOSITORY"> {
  const res = await gh.request<{ object?: { sha: string } } | Array<unknown>>("GET", `${repoPath(owner, repo)}/git/ref/heads/${encPath(branch)}`, {
    allowStatuses: [404, 409],
  });
  if (res.status === 409) return "EMPTY_REPOSITORY";
  if (res.status === 404 || Array.isArray(res.data)) return undefined;
  return res.data?.object?.sha;
}

/** Resolve a branch, tag or SHA to a commit SHA. */
export async function resolveCommitSha(gh: GitHubClient, owner: string, repo: string, refOrSha: string): Promise<string> {
  // The "sha" media type returns just the 40-char SHA instead of the full commit.
  const sha = await gh.get<string>(`${repoPath(owner, repo)}/commits/${encPath(refOrSha)}`, undefined, {
    accept: "application/vnd.github.sha",
    responseType: "text",
  });
  return sha.trim();
}

/**
 * Load the full recursive tree of a commit as a path -> entry map.
 * `truncated` is true for very large repositories (GitHub limit), in which case
 * callers must not rely on absence of a path.
 */
export async function getTreeMap(
  gh: GitHubClient,
  owner: string,
  repo: string,
  treeishSha: string,
): Promise<{ entries: Map<string, TreeEntry>; truncated: boolean; treeSha: string }> {
  const t = await gh.get<{ sha: string; tree: TreeEntry[]; truncated: boolean }>(`${repoPath(owner, repo)}/git/trees/${encPath(treeishSha)}`, { recursive: 1 });
  const entries = new Map<string, TreeEntry>();
  for (const e of t.tree) entries.set(e.path, e);
  return { entries, truncated: t.truncated, treeSha: t.sha };
}

export interface CommitResult {
  commit_sha: string;
  commit_url: string;
  branch: string;
  parent_sha: string | null;
  created_branch: boolean;
  files_changed: number;
}

export interface CommitOptions {
  owner: string;
  repo: string;
  branch?: string;
  message: string;
  changes: TreeChange[];
  /** If the branch does not exist, create it from this branch/tag/SHA. */
  createBranchFrom?: string;
  /** Fail if the branch head is not this SHA (optimistic concurrency). */
  expectedHeadSha?: string;
  author?: { name: string; email: string };
}

/** Create ONE commit containing all `changes` and advance the branch to it. */
export async function commitTreeChanges(gh: GitHubClient, opts: CommitOptions): Promise<CommitResult> {
  const { owner, repo, message } = opts;
  if (opts.changes.length === 0) throw new ToolInputError("No changes to commit.");

  const seen = new Set<string>();
  for (const c of opts.changes) {
    c.path = normalizePath(c.path);
    if (!c.path) throw new ToolInputError("Empty file path.");
    if (seen.has(c.path)) throw new ToolInputError(`Path appears more than once: ${c.path}`);
    seen.add(c.path);
  }

  const branch = opts.branch ?? (await getDefaultBranch(gh, owner, repo));
  let head = await getBranchHead(gh, owner, repo, branch);
  let createdBranch = false;
  let changes = opts.changes;

  if (head === "EMPTY_REPOSITORY") {
    // The Git Data API refuses to work on an empty repository. The Contents API
    // can create the very first commit, after which the rest is committed normally.
    const first = changes.find((c) => c.content !== undefined);
    if (!first) throw new ToolInputError("The repository is empty; the first commit must add at least one text file.");
    await gh.put(`${repoPath(owner, repo)}/contents/${encPath(first.path)}`, {
      message: changes.length === 1 ? message : `${message} (initial file)`,
      content: utf8ToBase64(first.content ?? ""),
      branch,
      ...(opts.author && { author: opts.author, committer: opts.author }),
    });
    changes = changes.filter((c) => c !== first);
    head = await getBranchHead(gh, owner, repo, branch);
    createdBranch = true;
    if (changes.length === 0 && typeof head === "string") {
      return { commit_sha: head, commit_url: `https://github.com/${owner}/${repo}/commit/${head}`, branch, parent_sha: null, created_branch: true, files_changed: 1 };
    }
  }

  let baseSha: string;
  let needsCreateRef = false;
  if (head === undefined || head === "EMPTY_REPOSITORY") {
    if (!opts.createBranchFrom) {
      throw new GitHubApiError(404, `Branch '${branch}' does not exist.`, "Create it first with create_branch, or pass create_branch_from (e.g. the default branch) so it is created as part of this commit.");
    }
    baseSha = await resolveCommitSha(gh, owner, repo, opts.createBranchFrom);
    needsCreateRef = true;
  } else {
    baseSha = head;
  }

  if (opts.expectedHeadSha && !needsCreateRef && !baseSha.toLowerCase().startsWith(opts.expectedHeadSha.toLowerCase())) {
    throw new GitHubApiError(409, `Branch '${branch}' moved: it is at ${baseSha}, not ${opts.expectedHeadSha}.`, hintForStatus(409));
  }

  const baseCommit = await gh.get<{ tree: { sha: string } }>(`${repoPath(owner, repo)}/git/commits/${enc(baseSha)}`);
  const { entries, truncated } = await getTreeMap(gh, owner, repo, baseCommit.tree.sha);

  const treeEntries = changes.map((c) => {
    const existing = entries.get(c.path);
    if (existing?.type === "tree" && c.sha !== null) throw new ToolInputError(`'${c.path}' is a directory, not a file.`);
    if (c.sha === null) {
      if (!existing && !truncated) throw new ToolInputError(`Cannot delete '${c.path}': it does not exist on branch '${branch}'.`);
      return { path: c.path, mode: (existing?.mode ?? "100644") as FileMode, type: "blob" as const, sha: null };
    }
    const mode = c.mode ?? ((existing?.type === "blob" ? existing.mode : "100644") as FileMode);
    return c.content !== undefined
      ? { path: c.path, mode, type: "blob" as const, content: c.content }
      : { path: c.path, mode, type: "blob" as const, sha: c.sha };
  });

  const newTree = await gh.post<{ sha: string }>(`${repoPath(owner, repo)}/git/trees`, { base_tree: baseCommit.tree.sha, tree: treeEntries });
  if (newTree.sha === baseCommit.tree.sha) {
    throw new ToolInputError("Nothing changed: the files already have exactly this content on the branch. No commit was created.");
  }

  const commit = await gh.post<{ sha: string; html_url: string }>(`${repoPath(owner, repo)}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [baseSha],
    ...(opts.author && { author: opts.author, committer: opts.author }),
  });

  if (needsCreateRef) {
    await gh.post(`${repoPath(owner, repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    createdBranch = true;
  } else {
    try {
      await gh.patch(`${repoPath(owner, repo)}/git/refs/heads/${encPath(branch)}`, { sha: commit.sha, force: false });
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422) {
        throw new GitHubApiError(
          409,
          `Branch '${branch}' was updated by someone else while committing (not a fast-forward). Nothing was pushed.`,
          "Re-read the files from the branch and commit again.",
          { orphan_commit: commit.sha },
        );
      }
      throw err;
    }
  }

  return {
    commit_sha: commit.sha,
    commit_url: commit.html_url,
    branch,
    parent_sha: baseSha,
    created_branch: createdBranch,
    files_changed: opts.changes.length,
  };
}

/** Convert a simple glob (*, **, ?) to a RegExp; plain text becomes a substring match. */
export function globToRegExp(pattern: string): RegExp {
  if (!/[*?]/.test(pattern)) {
    return new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&"), "i");
  }
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Patterns without a slash match against the file name anywhere in the tree.
  return pattern.includes("/") ? new RegExp(`^${re}$`, "i") : new RegExp(`(^|/)${re}$`, "i");
}
