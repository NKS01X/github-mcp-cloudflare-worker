import { z } from "zod";
import { summarizeCommit, truncate } from "../github/compact";
import { enc, encPath, type GitHubClient } from "../github/client";
import { base64ToBytes, decodeIfText, isValidBase64, utf8ToBase64 } from "../github/encoding";
import { GitHubApiError, ToolInputError } from "../github/errors";
import {
  commitTreeChanges,
  getBranchHead,
  getDefaultBranch,
  getTreeMap,
  globToRegExp,
  normalizePath,
  resolveCommitSha,
  type TreeChange,
} from "../github/gitops";
import { TextResult, branch, defineTool, filePath, pagination, ref, repoArgs, sha } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;
const DEFAULT_MAX_CHARS = 100_000;

interface ContentItem {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: string;
  target?: string;
  submodule_git_url?: string;
  html_url?: string;
  download_url?: string | null;
}

/** Fetch the current blob SHA of a file on a branch, or undefined if it does not exist. */
async function currentFileSha(gh: GitHubClient, owner: string, repo: string, path: string, branchName?: string): Promise<string | undefined> {
  const res = await gh.request<ContentItem | ContentItem[]>("GET", `${repoPath(owner, repo)}/contents/${encPath(path)}`, {
    query: { ref: branchName },
    allowStatuses: [404],
  });
  if (res.status === 404) return undefined;
  if (Array.isArray(res.data)) throw new ToolInputError(`'${path}' is a directory, not a file.`);
  return res.data.sha;
}

async function ensureBranch(gh: GitHubClient, owner: string, repo: string, branchName: string | undefined, from: string | undefined): Promise<boolean> {
  if (!branchName || !from) return false;
  const head = await getBranchHead(gh, owner, repo, branchName);
  if (typeof head === "string" || head === "EMPTY_REPOSITORY") return false;
  const base = await resolveCommitSha(gh, owner, repo, from);
  await gh.post(`${repoPath(owner, repo)}/git/refs`, { ref: `refs/heads/${branchName}`, sha: base });
  return true;
}

function listingEntry(i: ContentItem) {
  return { name: i.name, path: i.path, type: i.type, size: i.type === "file" ? i.size : undefined, sha: i.sha };
}

const fileChange = z.object({
  path: filePath,
  content: z.string().max(5_000_000).optional().describe("Full new file content. Omit when delete is true."),
  encoding: z.enum(["utf-8", "base64"]).default("utf-8").describe("'utf-8' for text (default). 'base64' for binary files such as images."),
  delete: z.boolean().default(false).describe("true removes this file in the commit."),
  executable: z.boolean().optional().describe("Mark the file executable (mode 100755)."),
});

export const fileTools = [
  defineTool({
    name: "get_file_contents",
    toolset: "files",
    title: "Read a file (or list a directory)",
    description:
      "Read a file's text content from a repository at any branch, tag or commit (default: the default branch). If 'path' is a directory, returns its listing instead. Returns the file's blob 'sha', which update operations can use to detect concurrent changes. Large files can be read in parts with start_line/end_line. Binary files return metadata only unless include_binary_base64 is set.",
    input: z.object({
      ...repoArgs,
      path: z.string().max(4096).default("").describe("File or directory path. Empty string = repository root."),
      ref: ref.optional(),
      start_line: z.number().int().min(1).optional().describe("First line to return (1-based)."),
      end_line: z.number().int().min(1).optional().describe("Last line to return (inclusive)."),
      max_chars: z.number().int().min(1000).max(500_000).default(DEFAULT_MAX_CHARS).describe("Truncate output after this many characters."),
      include_binary_base64: z.boolean().default(false).describe("For binary files up to 1 MB, include the base64 content."),
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const path = normalizePath(a.path);
      const data = await gh.get<ContentItem | ContentItem[]>(`${repoPath(a.owner, a.repo)}/contents/${encPath(path)}`, { ref: a.ref });

      if (Array.isArray(data)) {
        const entries = data.map(listingEntry);
        return { type: "directory", path: path || "/", ref: a.ref ?? "(default branch)", entries, count: entries.length };
      }
      if (data.type === "symlink") return { type: "symlink", path: data.path, target: data.target, sha: data.sha };
      if (data.type === "submodule") return { type: "submodule", path: data.path, submodule_git_url: data.submodule_git_url, commit_sha: data.sha };

      let bytes: Uint8Array;
      if (data.content && data.encoding === "base64") {
        bytes = base64ToBytes(data.content);
      } else {
        // Files over 1 MB: the JSON response omits content; fetch the raw bytes (up to 100 MB).
        bytes = await gh.get<Uint8Array>(`${repoPath(a.owner, a.repo)}/contents/${encPath(path)}`, { ref: a.ref }, {
          accept: "application/vnd.github.raw",
          responseType: "bytes",
        });
      }

      const decoded = decodeIfText(bytes);
      if (!decoded.isText) {
        const meta: Record<string, unknown> = { type: "binary_file", path: data.path, sha: data.sha, size: data.size, html_url: data.html_url, download_url: data.download_url };
        if (a.include_binary_base64) {
          if (bytes.length > 1_000_000) throw new ToolInputError("Binary file is larger than 1 MB; use download_url instead.");
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          meta.content_base64 = btoa(bin);
        }
        return meta;
      }

      let text = decoded.text;
      const totalLines = text.length === 0 ? 0 : text.split("\n").length;
      let range = "";
      if (a.start_line !== undefined || a.end_line !== undefined) {
        const lines = text.split("\n");
        const start = (a.start_line ?? 1) - 1;
        const end = Math.min(a.end_line ?? lines.length, lines.length);
        if (start >= lines.length) throw new ToolInputError(`start_line ${a.start_line} is past the end of the file (${lines.length} lines).`);
        text = lines.slice(start, end).join("\n");
        range = ` lines ${start + 1}-${end} of ${totalLines}`;
      }
      const t = truncate(text, a.max_chars);
      const header = [
        `path: ${data.path}`,
        `ref: ${a.ref ?? "(default branch)"}`,
        `sha: ${data.sha}`,
        `size: ${data.size} bytes, ${totalLines} lines${range}`,
        t.truncated ? `NOTE: output truncated at ${a.max_chars} characters; use start_line/end_line to read the rest.` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      return new TextResult(`${header}\n--- file content ---\n${t.text}`, {
        path: data.path,
        sha: data.sha,
        size: data.size,
        lines: totalLines,
        truncated: t.truncated,
      });
    },
  }),

  defineTool({
    name: "list_directory",
    toolset: "files",
    title: "List a directory",
    description: "List files and folders directly inside a directory (non-recursive). Use get_repository_tree for a recursive listing or search_files to find files by name.",
    input: z.object({ ...repoArgs, path: z.string().max(4096).default("").describe("Directory path. Empty = root."), ref: ref.optional() }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const path = normalizePath(a.path);
      const data = await gh.get<ContentItem | ContentItem[]>(`${repoPath(a.owner, a.repo)}/contents/${encPath(path)}`, { ref: a.ref });
      if (!Array.isArray(data)) throw new ToolInputError(`'${path}' is a ${data.type}, not a directory. Use get_file_contents to read it.`);
      return { path: path || "/", entries: data.map(listingEntry), count: data.length };
    },
  }),

  defineTool({
    name: "get_repository_tree",
    toolset: "files",
    title: "Get the repository file tree",
    description:
      "Return the repository's file tree (recursive) at a branch, tag or commit, optionally limited to a sub-directory. Good for understanding project structure before editing. Very large repositories may be truncated by GitHub.",
    input: z.object({
      ...repoArgs,
      ref: ref.optional(),
      path_prefix: z.string().max(4096).optional().describe("Only include paths under this directory, e.g. 'src/'."),
      include_directories: z.boolean().default(false),
      max_entries: z.number().int().min(1).max(5000).default(1000),
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const refName = a.ref ?? (await getDefaultBranch(gh, a.owner, a.repo));
      const { entries, truncated } = await getTreeMap(gh, a.owner, a.repo, refName);
      const prefix = a.path_prefix ? `${normalizePath(a.path_prefix)}/` : "";
      const all = [...entries.values()].filter((e) => (!prefix || e.path.startsWith(prefix)) && (a.include_directories || e.type !== "tree"));
      return {
        ref: refName,
        total_matching: all.length,
        entries: all.slice(0, a.max_entries).map((e) => (e.type === "tree" ? { path: `${e.path}/`, type: "dir" } : { path: e.path, size: e.size, ...(e.type === "commit" && { type: "submodule" }) })),
        truncated_by_limit: all.length > a.max_entries,
        truncated_by_github: truncated,
      };
    },
  }),

  defineTool({
    name: "search_files",
    toolset: "files",
    title: "Find files by name or path",
    description:
      "Find files in ONE repository whose path matches a pattern. Supports globs ('*.ts', 'src/**/*.test.ts', 'README*') or plain substrings ('config'). Works on any branch and does not depend on GitHub's search index. To search file CONTENTS use search_code.",
    input: z.object({
      ...repoArgs,
      pattern: z.string().min(1).max(500).describe("Glob or substring, matched case-insensitively."),
      ref: ref.optional(),
      max_results: z.number().int().min(1).max(1000).default(200),
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const refName = a.ref ?? (await getDefaultBranch(gh, a.owner, a.repo));
      const { entries, truncated } = await getTreeMap(gh, a.owner, a.repo, refName);
      const re = globToRegExp(a.pattern);
      const matches = [...entries.values()].filter((e) => e.type === "blob" && re.test(e.path));
      return {
        ref: refName,
        pattern: a.pattern,
        total_matches: matches.length,
        files: matches.slice(0, a.max_results).map((e) => ({ path: e.path, size: e.size })),
        ...(truncated && { warning: "Repository tree was truncated by GitHub; some files may be missing from results." }),
      };
    },
  }),

  defineTool({
    name: "get_file_metadata",
    toolset: "files",
    title: "Get file metadata",
    description: "Get a file's metadata without its content: blob sha, size, type, URLs and the last commit that changed it.",
    input: z.object({ ...repoArgs, path: filePath, ref: ref.optional() }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const path = normalizePath(a.path);
      const data = await gh.get<ContentItem | ContentItem[]>(`${repoPath(a.owner, a.repo)}/contents/${encPath(path)}`, { ref: a.ref });
      if (Array.isArray(data)) return { type: "dir", path, entries: data.length };
      const commits = await gh.get<Array<Record<string, unknown>>>(`${repoPath(a.owner, a.repo)}/commits`, { path, sha: a.ref, per_page: 1 });
      return {
        path: data.path,
        type: data.type,
        sha: data.sha,
        size: data.size,
        html_url: data.html_url,
        download_url: data.download_url,
        last_commit: commits[0] ? summarizeCommit(commits[0]) : null,
      };
    },
  }),

  defineTool({
    name: "get_file_history",
    toolset: "files",
    title: "Get a file's commit history",
    description: "List the commits that changed a specific file or directory, newest first. Note: GitHub's API does not follow renames; history before a rename is under the old path.",
    input: z.object({
      ...repoArgs,
      path: filePath,
      ref: ref.optional(),
      since: z.string().datetime().optional().describe("ISO 8601 timestamp."),
      until: z.string().datetime().optional(),
      ...pagination,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/commits`, {
        path: normalizePath(a.path),
        sha: a.ref,
        since: a.since,
        until: a.until,
        per_page: a.per_page,
        page: a.page,
      });
      return { path: a.path, commits: items.map(summarizeCommit), pagination: p };
    },
  }),

  defineTool({
    name: "get_file_blame",
    toolset: "files",
    title: "Blame a file",
    description: "Show which commit last changed each line range of a file (git blame), via GitHub GraphQL. Optionally restrict to a line range.",
    input: z.object({
      ...repoArgs,
      path: filePath,
      ref: ref.optional(),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const refName = a.ref ?? (await getDefaultBranch(gh, a.owner, a.repo));
      const q = `query($owner:String!,$name:String!,$expr:String!,$path:String!){
        repository(owner:$owner,name:$name){ object(expression:$expr){ ... on Commit { oid blame(path:$path){ ranges {
          startingLine endingLine age commit { oid messageHeadline committedDate author { name user { login } } } } } } } } }`;
      const data = await gh.graphql<{ repository: { object: { oid: string; blame: { ranges: Array<Record<string, unknown>> } } | null } }>(q, {
        owner: a.owner,
        name: a.repo,
        expr: refName,
        path: normalizePath(a.path),
      });
      const obj = data.repository?.object;
      if (!obj) throw new GitHubApiError(404, `Ref '${refName}' not found.`, "Check the branch/tag/SHA.");
      const ranges = obj.blame.ranges
        .filter((r) => (a.start_line === undefined || (r.endingLine as number) >= a.start_line) && (a.end_line === undefined || (r.startingLine as number) <= a.end_line))
        .map((r) => {
          const c = r.commit as Record<string, unknown>;
          const author = c.author as { name: string; user?: { login: string } | null };
          return { lines: `${r.startingLine}-${r.endingLine}`, sha: c.oid, message: c.messageHeadline, author: author.user?.login ?? author.name, date: c.committedDate };
        });
      return { path: a.path, commit: obj.oid, ranges };
    },
  }),

  defineTool({
    name: "create_or_update_file",
    toolset: "files",
    title: "Create or update one file (commits immediately)",
    description:
      "Create a new file or replace an existing file's full content on a branch. This makes a commit and pushes it at once — no separate commit/push step is needed. For several files in ONE commit use commit_files instead. If 'sha' (from get_file_contents) is given, the update fails when the file changed since you read it; without it the current version is overwritten. Set create_branch_from to create the branch first if it does not exist.",
    input: z.object({
      ...repoArgs,
      path: filePath,
      content: z.string().max(5_000_000).describe("The complete new file content (not a diff)."),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8").describe("'base64' if content is base64-encoded binary data."),
      message: z.string().min(1).max(5000).describe("Commit message, e.g. 'Add dashboard utilities'."),
      branch: branch.optional().describe("Target branch. Defaults to the repository's default branch."),
      sha: sha.optional().describe("Blob SHA of the file you are replacing (from get_file_contents). Recommended for updates."),
      create_branch_from: z.string().optional().describe("If 'branch' does not exist, create it from this branch/tag/SHA first."),
      author_name: z.string().optional(),
      author_email: z.string().email().optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const path = normalizePath(a.path);
      if (a.encoding === "base64" && !isValidBase64(a.content)) throw new ToolInputError("content is not valid base64.");
      const createdBranch = await ensureBranch(gh, a.owner, a.repo, a.branch, a.create_branch_from);
      const existingSha = a.sha ?? (await currentFileSha(gh, a.owner, a.repo, path, a.branch));
      const author = a.author_name && a.author_email ? { name: a.author_name, email: a.author_email } : undefined;
      const res = await gh.put<{ content: Record<string, unknown>; commit: Record<string, unknown> }>(`${repoPath(a.owner, a.repo)}/contents/${encPath(path)}`, {
        message: a.message,
        content: a.encoding === "base64" ? a.content.replace(/\s+/g, "") : utf8ToBase64(a.content),
        branch: a.branch,
        sha: existingSha,
        ...(author && { author, committer: author }),
      });
      return {
        action: existingSha ? "updated" : "created",
        path,
        branch: a.branch ?? "(default branch)",
        created_branch: createdBranch,
        file_sha: res.content?.sha,
        commit_sha: res.commit?.sha,
        commit_url: res.commit?.html_url,
        file_url: res.content?.html_url,
      };
    },
  }),

  defineTool({
    name: "delete_file",
    toolset: "files",
    title: "Delete one file (commits immediately)",
    description:
      "Delete a single file from a branch with a commit (pushed immediately). The file remains in git history and can be restored. To delete several files in one commit, use commit_files with delete: true entries.",
    input: z.object({
      ...repoArgs,
      path: filePath,
      message: z.string().min(1).max(5000).describe("Commit message, e.g. 'Remove obsolete config'."),
      branch: branch.optional(),
      sha: sha.optional().describe("Blob SHA of the file (optional; fetched automatically)."),
    }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      const path = normalizePath(a.path);
      const fileSha = a.sha ?? (await currentFileSha(gh, a.owner, a.repo, path, a.branch));
      if (!fileSha) throw new GitHubApiError(404, `File '${path}' not found on ${a.branch ?? "the default branch"}.`, "Check the path and branch (paths are case-sensitive).");
      const res = await gh.delete<{ commit: Record<string, unknown> }>(`${repoPath(a.owner, a.repo)}/contents/${encPath(path)}`, {
        message: a.message,
        sha: fileSha,
        branch: a.branch,
      });
      return { deleted: path, branch: a.branch ?? "(default branch)", commit_sha: res.commit?.sha, commit_url: res.commit?.html_url };
    },
  }),

  defineTool({
    name: "commit_files",
    toolset: "files",
    title: "Commit and push multiple file changes",
    description:
      "Create ONE commit that adds, updates and/or deletes any number of files, and push it to a branch (the branch on GitHub moves to the new commit immediately — this is the 'push'). Use this for multi-file changes like 'create these files and commit with message X'. Each file needs its full new content. Set create_branch_from to create a new branch as part of the commit (e.g. branch 'feature/x' from 'main'). Set expected_head_sha to refuse the commit if someone else pushed in the meantime. Works on empty repositories too.",
    input: z.object({
      ...repoArgs,
      branch: branch.optional().describe("Branch to commit to. Defaults to the default branch."),
      message: z.string().min(1).max(10_000).describe("Commit message."),
      files: z.array(fileChange).min(1).max(200).describe("Files to add/update/delete in this commit."),
      create_branch_from: z.string().optional().describe("If 'branch' does not exist, create it from this branch/tag/SHA."),
      expected_head_sha: sha.optional().describe("Abort if the branch head is not this commit (protects against overwriting concurrent pushes)."),
      author_name: z.string().optional(),
      author_email: z.string().email().optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      // Each base64 file needs its own blob upload; keep within Workers' per-request subrequest budget.
      const binaryCount = a.files.filter((f) => !f.delete && f.encoding === "base64").length;
      if (binaryCount > 40) throw new ToolInputError(`Too many base64 (binary) files in one commit (${binaryCount}); split into commits of at most 40 binary files.`);
      const changes: TreeChange[] = [];
      for (const f of a.files) {
        const path = normalizePath(f.path);
        if (f.delete) {
          changes.push({ path, sha: null });
          continue;
        }
        if (f.content === undefined) throw new ToolInputError(`File '${path}' needs 'content' (or delete: true).`);
        const mode = f.executable ? ("100755" as const) : undefined;
        if (f.encoding === "base64") {
          if (!isValidBase64(f.content)) throw new ToolInputError(`Content of '${path}' is not valid base64.`);
          const blob = await gh.post<{ sha: string }>(`${repoPath(a.owner, a.repo)}/git/blobs`, { content: f.content.replace(/\s+/g, ""), encoding: "base64" });
          changes.push({ path, sha: blob.sha, mode });
        } else {
          changes.push({ path, content: f.content, mode });
        }
      }
      const author = a.author_name && a.author_email ? { name: a.author_name, email: a.author_email } : undefined;
      const result = await commitTreeChanges(gh, {
        owner: a.owner,
        repo: a.repo,
        branch: a.branch,
        message: a.message,
        changes,
        createBranchFrom: a.create_branch_from,
        expectedHeadSha: a.expected_head_sha,
        author,
      });
      return {
        ...result,
        pushed: true,
        added_or_updated: a.files.filter((f) => !f.delete).map((f) => normalizePath(f.path)),
        deleted: a.files.filter((f) => f.delete).map((f) => normalizePath(f.path)),
      };
    },
  }),

  defineTool({
    name: "move_file",
    toolset: "files",
    title: "Rename or move a file or directory",
    description:
      "Rename/move a file — or a whole directory — within a repository in a single commit, preserving content exactly (equivalent to 'git mv' + commit + push). Fails if the destination already exists unless overwrite is true.",
    input: z.object({
      ...repoArgs,
      from_path: filePath.describe("Existing file or directory path."),
      to_path: filePath.describe("New path."),
      message: z.string().min(1).max(5000).optional().describe("Commit message. Default: 'Move <from> to <to>'."),
      branch: branch.optional(),
      overwrite: z.boolean().default(false),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const from = normalizePath(a.from_path);
      const to = normalizePath(a.to_path);
      if (from === to) throw new ToolInputError("from_path and to_path are the same.");
      if (to.startsWith(`${from}/`)) throw new ToolInputError("Cannot move a directory into itself.");
      const branchName = a.branch ?? (await getDefaultBranch(gh, a.owner, a.repo));
      const head = await getBranchHead(gh, a.owner, a.repo, branchName);
      if (typeof head !== "string") throw new GitHubApiError(404, `Branch '${branchName}' not found.`, "Check the branch name.");
      const { entries, truncated } = await getTreeMap(gh, a.owner, a.repo, head);
      if (truncated) throw new ToolInputError("Repository tree is too large for a safe move via the API (GitHub truncated it).");

      const src = entries.get(from);
      if (!src) throw new GitHubApiError(404, `'${from}' does not exist on '${branchName}'.`, "Check the path (case-sensitive).");
      const moves: Array<{ from: string; to: string; sha: string; mode: string }> = [];
      if (src.type === "tree") {
        for (const e of entries.values()) {
          if (e.type !== "tree" && e.path.startsWith(`${from}/`)) moves.push({ from: e.path, to: `${to}${e.path.slice(from.length)}`, sha: e.sha, mode: e.mode });
        }
        if (moves.length > 1000) throw new ToolInputError(`Directory has ${moves.length} files; moves are limited to 1000 files per call.`);
      } else {
        moves.push({ from, to, sha: src.sha, mode: src.mode });
      }
      if (!a.overwrite) {
        const clash = moves.find((m) => entries.has(m.to));
        if (clash) throw new ToolInputError(`Destination '${clash.to}' already exists. Pass overwrite: true to replace it.`);
      }
      const changes: TreeChange[] = [];
      for (const m of moves) {
        changes.push({ path: m.to, sha: m.sha, mode: m.mode as TreeChange["mode"] });
        changes.push({ path: m.from, sha: null });
      }
      const result = await commitTreeChanges(gh, {
        owner: a.owner,
        repo: a.repo,
        branch: branchName,
        message: a.message ?? `Move ${from} to ${to}`,
        changes,
        expectedHeadSha: head,
      });
      return { ...result, moved: moves.map((m) => ({ from: m.from, to: m.to })) };
    },
  }),
];

