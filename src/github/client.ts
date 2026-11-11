import { GITHUB_API_VERSION, SERVER_NAME, SERVER_VERSION } from "../config";
import {
  GitHubApiError,
  GitHubNetworkError,
  GitHubRateLimitError,
  MissingTokenError,
  hintForStatus,
} from "./errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  body?: unknown;
  /** Raw body (e.g. release asset bytes). Overrides `body`. */
  rawBody?: BodyInit;
  accept?: string;
  headers?: Record<string, string>;
  /** Return response text instead of parsed JSON (diffs, raw files). */
  responseType?: "json" | "text" | "bytes" | "none";
  /** Absolute URL instead of a path under the API base (e.g. uploads.github.com). */
  absoluteUrl?: string;
  /** Statuses that should be returned instead of thrown (e.g. 404 when probing existence). */
  allowStatuses?: number[];
  /** "manual" returns 3xx responses (with Location) instead of following them. */
  redirect?: "follow" | "manual";
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface Pagination {
  page: number;
  per_page: number;
  has_next_page: boolean;
  next_page?: number;
  last_page?: number;
}

export interface GitHubClientOptions {
  token: string | undefined;
  apiUrl: string;
  graphqlUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Longest we will wait in-process for a rate limit / Retry-After before failing. */
  maxWaitMs?: number;
  now?: () => number;
}

const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/** Encode one URL path segment (owner, repo, branch name …). */
export function enc(segment: string | number): string {
  return encodeURIComponent(String(segment));
}

/** Encode a repository file path, keeping "/" separators. */
export function encPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** Parse the RFC 5988 Link header GitHub uses for pagination. */
export function parseLinkHeader(link: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!link) return out;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (!m) continue;
    try {
      const page = new URL(m[1]).searchParams.get("page");
      if (page) out[m[2]] = Number(page);
    } catch {
      /* ignore malformed links */
    }
  }
  return out;
}

/** Remove anything token-shaped from text that may reach the client. */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("[REDACTED]");
  }
  return out
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/(authorization["']?\s*[:=]\s*["']?)(bearer|token)\s+[^\s"',}]+/gi, "$1$2 [REDACTED]");
}

export class GitHubClient {
  private readonly token: string | undefined;
  readonly apiUrl: string;
  readonly graphqlUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token?.trim() || undefined;
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.graphqlUrl = opts.graphqlUrl;
    // Bind so Workers' fetch keeps its `this`.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  /** Redact this client's token (and token-shaped strings) from text. */
  redact(text: string): string {
    return redactSecrets(text, [this.token]);
  }

  buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.apiUrl}${path.startsWith("/") ? "" : "/"}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
      }
    }
    return url.toString();
  }

  private baseHeaders(accept?: string): Headers {
    if (!this.token) throw new MissingTokenError();
    return new Headers({
      Accept: accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
    });
  }

  async request<T = unknown>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = opts.absoluteUrl ?? this.buildUrl(path, opts.query);
    const headers = this.baseHeaders(opts.accept);
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

    let body: BodyInit | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers.set("Content-Type", "application/json");
    }

    const idempotent = IDEMPOTENT.has(method);
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, redirect: opts.redirect ?? "follow" });
      } catch (err) {
        if (idempotent && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt++));
          continue;
        }
        throw new GitHubNetworkError(this.redact(`Could not reach GitHub (${method} ${new URL(url).pathname}): ${(err as Error)?.message ?? String(err)}`));
      }

      const manualRedirect = opts.redirect === "manual" && res.status >= 300 && res.status < 400;
      if (manualRedirect) {
        await res.body?.cancel();
        return { status: res.status, data: undefined as T, headers: res.headers };
      }
      if (res.ok || opts.allowStatuses?.includes(res.status)) {
        return { status: res.status, data: await this.readBody<T>(res, opts.responseType), headers: res.headers };
      }

      const errorBody = await this.readErrorBody(res);

      // Primary rate limit, secondary rate limit, or 429.
      const rateLimit = this.rateLimitInfo(res, errorBody.message);
      if (rateLimit.limited) {
        if (rateLimit.waitMs !== undefined && rateLimit.waitMs <= this.maxWaitMs && attempt < this.maxRetries) {
          await this.sleep(Math.max(rateLimit.waitMs, 250));
          attempt++;
          continue;
        }
        throw new GitHubRateLimitError(res.status, this.redact(errorBody.message || "Rate limit exceeded"), rateLimit.resetAt, {
          method,
          path: new URL(url).pathname,
        });
      }

      if (RETRYABLE_STATUS.has(res.status) && idempotent && attempt < this.maxRetries) {
        await this.sleep(this.backoff(attempt++));
        continue;
      }

      throw this.toApiError(res, errorBody, method, url);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(4000, 300 * 2 ** attempt) + Math.floor(Math.random() * 100);
  }

  private async readBody<T>(res: Response, type: RequestOptions["responseType"] = "json"): Promise<T> {
    if (type === "none" || res.status === 204 || res.status === 205) {
      await res.body?.cancel();
      return undefined as T;
    }
    if (type === "text") return (await res.text()) as T;
    if (type === "bytes") return new Uint8Array(await res.arrayBuffer()) as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private async readErrorBody(res: Response): Promise<{ message: string; raw: Record<string, unknown> }> {
    const text = await res.text().catch(() => "");
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return { message: String(json.message ?? res.statusText ?? ""), raw: json };
    } catch {
      return { message: text.slice(0, 500) || res.statusText, raw: {} };
    }
  }

  private rateLimitInfo(res: Response, message: string): { limited: boolean; waitMs?: number; resetAt?: string } {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    const retryAfter = res.headers.get("retry-after");
    const secondary = /secondary rate limit|abuse detection/i.test(message);
    const primary = (res.status === 403 || res.status === 429) && remaining === "0";
    if (!(res.status === 429 || primary || (res.status === 403 && (secondary || retryAfter !== null)))) {
      return { limited: false };
    }
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
      const waitMs = Number(retryAfter) * 1000;
      return { limited: true, waitMs, resetAt: new Date(this.now() + waitMs).toISOString() };
    }
    if (primary && reset) {
      const resetMs = Number(reset) * 1000;
      return { limited: true, waitMs: Math.max(0, resetMs - this.now()), resetAt: new Date(resetMs).toISOString() };
    }
    // Secondary limit without Retry-After: GitHub recommends waiting at least a minute.
    return { limited: true, waitMs: 60_000, resetAt: undefined };
  }

  private toApiError(res: Response, body: { message: string; raw: Record<string, unknown> }, method: string, url: string): GitHubApiError {
    const details: Record<string, unknown> = { method, path: new URL(url).pathname };
    if (body.raw.errors) details.errors = body.raw.errors;
    if (body.raw.documentation_url) details.documentation_url = body.raw.documentation_url;
    const accepted = res.headers.get("x-accepted-github-permissions");
    if (accepted) details.accepted_permissions = accepted;
    const scopes = res.headers.get("x-accepted-oauth-scopes");
    if (scopes) details.accepted_oauth_scopes = scopes;
    const sso = res.headers.get("x-github-sso");
    if (sso) details.sso = "This organization requires SAML SSO. Authorize the token for the organization in GitHub > Settings > Developer settings > Personal access tokens.";
    return new GitHubApiError(res.status, this.redact(body.message || `HTTP ${res.status}`), hintForStatus(res.status), JSON.parse(this.redact(JSON.stringify(details))));
  }

  // Convenience helpers -----------------------------------------------------

  async get<T = unknown>(path: string, query?: RequestOptions["query"], opts: Omit<RequestOptions, "query"> = {}): Promise<T> {
    return (await this.request<T>("GET", path, { ...opts, query })).data;
  }

  async post<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return (await this.request<T>("POST", path, { ...opts, body })).data;
  }

  async patch<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return (await this.request<T>("PATCH", path, { ...opts, body })).data;
  }

  async put<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return (await this.request<T>("PUT", path, { ...opts, body })).data;
  }

  async delete<T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return (await this.request<T>("DELETE", path, { ...opts, body })).data;
  }

  /**
   * Download a URL GitHub redirected us to (signed log/archive URLs) WITHOUT
   * sending the GitHub token to the third-party host.
   */
  async fetchRedirectTarget(location: string): Promise<string> {
    const res = await this.fetchImpl(location, { method: "GET", redirect: "follow" });
    if (!res.ok) throw new GitHubApiError(res.status, `Download failed with HTTP ${res.status}`, hintForStatus(res.status));
    return await res.text();
  }

  /** GET one page of a list endpoint and report pagination state. */
  async getPage<T = unknown>(
    path: string,
    query: RequestOptions["query"] & { page?: number; per_page?: number } = {},
    opts: Omit<RequestOptions, "query"> = {},
  ): Promise<{ items: T[]; pagination: Pagination; raw: unknown }> {
    const page = query.page ?? 1;
    const perPage = query.per_page ?? 30;
    const res = await this.request<unknown>("GET", path, { ...opts, query: { ...query, page, per_page: perPage } });
    const links = parseLinkHeader(res.headers.get("link"));
    const raw = res.data;
    let items: T[] = [];
    if (Array.isArray(raw)) items = raw as T[];
    else if (raw && typeof raw === "object") {
      // Some list endpoints wrap results: {total_count, workflows: [...]}
      const arr = Object.values(raw as Record<string, unknown>).find(Array.isArray);
      if (arr) items = arr as T[];
    }
    return {
      items,
      raw,
      pagination: {
        page,
        per_page: perPage,
        has_next_page: links.next !== undefined,
        ...(links.next !== undefined && { next_page: links.next }),
        ...(links.last !== undefined && { last_page: links.last }),
      },
    };
  }

  /** Run a GraphQL query or mutation. Errors are raised as GitHubApiError. */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.request<{ data?: T; errors?: Array<{ message: string; type?: string; path?: unknown }> }>("POST", "", {
      absoluteUrl: this.graphqlUrl,
      body: { query, variables },
    });
    const payload = res.data;
    if (payload?.errors?.length) {
      const first = payload.errors[0];
      const type = first.type ?? "";
      const status = type === "NOT_FOUND" ? 404 : type === "FORBIDDEN" || type === "INSUFFICIENT_SCOPES" ? 403 : 422;
      throw new GitHubApiError(status, this.redact(payload.errors.map((e) => e.message).join("; ")), hintForStatus(status), {
        graphql_errors: JSON.parse(this.redact(JSON.stringify(payload.errors))),
      });
    }
    return payload?.data as T;
  }
}
