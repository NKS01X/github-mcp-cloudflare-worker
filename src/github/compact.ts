/**
 * GitHub REST responses are very verbose (dozens of *_url fields per object).
 * Compacting them keeps tool results small enough for Claude's context while
 * keeping every field that matters for reasoning.
 */

const KEEP_URL_KEYS = new Set([
  "html_url",
  "clone_url",
  "ssh_url",
  "download_url",
  "browser_download_url",
  "homepage",
  "diff_url",
  "patch_url",
  "logs_url",
  "badge_url",
  "upload_url",
  "archive_download_url",
  "blob_url",
  "raw_url",
  "url_template",
  "target_url",
  "details_url",
]);

const DROP_KEYS = new Set(["node_id", "gravatar_id", "_links", "reactions", "performed_via_github_app"]);

function isUserLike(value: Record<string, unknown>): boolean {
  return typeof value.login === "string" && "type" in value && ("avatar_url" in value || "html_url" in value) && !("full_name" in value);
}

/** Recursively drop noise fields and collapse user objects to their login. */
export function compact<T = unknown>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => compact(v, depth + 1)) as unknown as T;

  const obj = value as Record<string, unknown>;
  if (depth > 0 && isUserLike(obj)) {
    return (obj.type === "Bot" ? `${obj.login}` : obj.login) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (DROP_KEYS.has(key)) continue;
    if (key === "url" && ("html_url" in obj || depth > 0)) continue;
    if (key.endsWith("_url") && !KEEP_URL_KEYS.has(key)) continue;
    if (v === null || v === undefined) continue;
    out[key] = compact(v, depth + 1);
  }
  return out as T;
}

/** Pick a subset of keys (after compaction) — used for list results. */
export function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== "object") return out;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const REPO_SUMMARY_KEYS = [
  "full_name",
  "description",
  "private",
  "visibility",
  "fork",
  "archived",
  "default_branch",
  "language",
  "stargazers_count",
  "forks_count",
  "open_issues_count",
  "topics",
  "pushed_at",
  "updated_at",
  "html_url",
];

export function summarizeRepo(repo: Record<string, unknown>): Record<string, unknown> {
  return compact(pick(repo, REPO_SUMMARY_KEYS));
}

export function summarizeIssue(issue: Record<string, unknown>): Record<string, unknown> {
  const s = compact(
    pick(issue, ["number", "title", "state", "state_reason", "user", "labels", "assignees", "milestone", "comments", "created_at", "updated_at", "closed_at", "html_url", "draft"]),
  ) as Record<string, unknown>;
  if (Array.isArray(s.labels)) s.labels = (s.labels as Array<Record<string, unknown> | string>).map((l) => (typeof l === "string" ? l : l.name));
  if (s.milestone && typeof s.milestone === "object") s.milestone = (s.milestone as Record<string, unknown>).title;
  if (issue.pull_request) s.is_pull_request = true;
  return s;
}

export function summarizePull(pr: Record<string, unknown>): Record<string, unknown> {
  const head = pr.head as Record<string, unknown> | undefined;
  const base = pr.base as Record<string, unknown> | undefined;
  const s = compact(
    pick(pr, ["number", "title", "state", "draft", "user", "labels", "created_at", "updated_at", "merged_at", "closed_at", "html_url"]),
  ) as Record<string, unknown>;
  if (Array.isArray(s.labels)) s.labels = (s.labels as Array<Record<string, unknown>>).map((l) => l.name);
  if (head) s.head = head.label ?? head.ref;
  if (base) s.base = base.ref;
  return s;
}

export function summarizeCommit(c: Record<string, unknown>): Record<string, unknown> {
  const commit = (c.commit ?? {}) as Record<string, unknown>;
  const author = (commit.author ?? {}) as Record<string, unknown>;
  const message = typeof commit.message === "string" ? commit.message : "";
  return {
    sha: c.sha,
    message: message.length > 500 ? `${message.slice(0, 500)}…` : message,
    author: (c.author as Record<string, unknown> | null)?.login ?? author.name,
    date: author.date,
    html_url: c.html_url,
  };
}

/** Truncate long text with a clear marker. */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`, truncated: true };
}
