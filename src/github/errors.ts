/** Errors that tools turn into structured, Claude-readable error results. */

export class GitHubApiError extends Error {
  readonly status: number;
  readonly hint: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, message: string, hint: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.hint = hint;
    this.details = details;
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  constructor(status: number, message: string, resetAt: string | undefined, details: Record<string, unknown> = {}) {
    super(
      status,
      message,
      resetAt
        ? `GitHub rate limit reached. It resets at ${resetAt}. Wait until then, or reduce the number of calls (use narrower searches, fewer pages).`
        : "GitHub secondary rate limit reached (too many requests in a short time). Wait a minute before retrying and avoid rapid bursts of write operations.",
      { ...details, rate_limit_reset: resetAt },
    );
    this.name = "GitHubRateLimitError";
  }
}

export class GitHubNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubNetworkError";
  }
}

/** The caller supplied arguments that are valid JSON but not a valid request. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** A destructive tool was called without the required explicit confirmation. */
export class ConfirmationRequiredError extends Error {
  readonly expected: string;
  constructor(action: string, expected: string) {
    super(
      `Confirmation required: ${action}. This cannot be undone. Ask the user to explicitly approve, then call this tool again with confirm set exactly to "${expected}".`,
    );
    this.name = "ConfirmationRequiredError";
    this.expected = expected;
  }
}

/** The operation is not supported by the GitHub API or by this server. */
export class UnsupportedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOperationError";
  }
}

export class MissingTokenError extends Error {
  constructor() {
    super(
      "GITHUB_TOKEN is not configured on this Worker. Run `npx wrangler secret put GITHUB_TOKEN`, paste a GitHub Personal Access Token, then try again (no redeploy needed).",
    );
    this.name = "MissingTokenError";
  }
}

const STATUS_HINTS: Record<number, string> = {
  400: "GitHub rejected the request as malformed. Check the arguments.",
  401: "The GitHub token was rejected (invalid, expired or revoked). Create a new Personal Access Token and run `npx wrangler secret put GITHUB_TOKEN`.",
  403: "The token is valid but not allowed to do this. For fine-grained tokens, make sure this repository is selected and the needed permission is granted (see accepted_permissions if present). Organization policies or SSO authorization can also block access.",
  404: "Not found. The owner, repository, path, branch or number may be wrong — or the token cannot see it (GitHub returns 404 instead of 403 for private resources the token has no access to).",
  405: "GitHub does not allow this operation in the resource's current state (for example, the pull request is not mergeable).",
  409: "Conflict. The resource changed in the meantime (stale sha), the repository is empty, or there is a merge conflict. Re-read the current state and retry.",
  410: "This resource is gone or the feature is disabled for this repository (for example, issues or discussions are turned off).",
  422: "Validation failed. Check the details field for which argument GitHub rejected.",
  451: "Access blocked for legal reasons (for example, trade controls or a DMCA takedown).",
};

export function hintForStatus(status: number): string {
  if (STATUS_HINTS[status]) return STATUS_HINTS[status];
  if (status >= 500) return "GitHub had a server error. This is usually temporary; retry in a moment.";
  return "The GitHub API returned an error.";
}
