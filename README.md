# GitHub MCP Server for Claude (Cloudflare Workers)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude work with GitHub in plain language — read and edit files, commit and push, manage branches, pull requests, issues, Actions, releases and more — without you running any `git` commands.

It runs on **Cloudflare Workers** (free plan is enough), authenticates to GitHub with **your Personal Access Token** stored as a Worker Secret, and connects to Claude as a **custom connector**.

```
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npm run deploy        # prints your MCP endpoint URL — paste it into Claude
```

---

## Contents

1. [How it works](#1-how-it-works)
2. [Prerequisites](#2-prerequisites)
3. [Install dependencies](#3-install-dependencies)
4. [Create a GitHub Personal Access Token](#4-create-a-github-personal-access-token)
5. [Choose token permissions](#5-choose-token-permissions)
6. [Log in to Cloudflare](#6-log-in-to-cloudflare)
7. [Add `GITHUB_TOKEN` as a Worker Secret](#7-add-github_token-as-a-worker-secret)
8. [Deploy](#8-deploy)
9. [Find your MCP endpoint](#9-find-your-mcp-endpoint)
10. [Connect it to Claude](#10-connect-it-to-claude)
11. [Using the tools](#11-using-the-tools)
12. [Tool reference](#12-tool-reference)
13. [Configuration](#13-configuration)
14. [Security model](#14-security-model)
15. [Troubleshooting](#15-troubleshooting)
16. [Updating and redeploying](#16-updating-and-redeploying)
17. [Development and tests](#17-development-and-tests)
18. [Limitations](#18-limitations)

---

## 1. How it works

```
Claude ──HTTPS (MCP, Streamable HTTP)──▶ Cloudflare Worker ──REST/GraphQL──▶ GitHub API
          /mcp/<MCP_ACCESS_KEY>             (this project)      Bearer GITHUB_TOKEN
```

There are **two separate credentials**:

| Credential | Purpose | Where it lives | Who creates it |
|---|---|---|---|
| `GITHUB_TOKEN` | What the server may do **on GitHub** | Worker Secret | You (step 7) |
| `MCP_ACCESS_KEY` | Who may talk **to this server** | Worker Secret + the endpoint URL | `npm run deploy`, automatically |

Why the access key? Claude's custom connector screen accepts a server URL (plus optional OAuth). Without protection, anyone who guessed your `workers.dev` URL could act on GitHub with your token. Instead of building OAuth infrastructure, the deploy script generates a 256-bit random key and puts it in the URL path (`/mcp/<key>`). That is the simplest mechanism that works with Claude's connector UI. Treat the full URL like a password.

**Implementation highlights**

- Official Cloudflare Agents SDK `createMcpHandler` (`agents/mcp/server`) with an MCP SDK v2 server (`@modelcontextprotocol/server`) — the stateless, currently recommended pattern. No Durable Objects, KV, databases or OAuth apps.
- Streamable HTTP transport. Serves both 2025-era clients (`initialize` handshake, e.g. `2025-06-18`, `2025-11-25`) and the stateless `2026-07-28` protocol revision.
- 148 tools in 15 toolsets, each with a Zod input schema (sent to Claude as JSON Schema), MCP tool annotations (`readOnlyHint`, `destructiveHint`, …), structured results and actionable errors.
- GitHub REST API version `2026-03-10`, GraphQL where REST has no equivalent (Discussions, blame, draft-PR toggles).
- Commits and pushes use GitHub's Git Data API (blobs → tree → commit → move branch ref): one commit for any number of files, fast-forward only, with conflict detection.
- Retries for transient failures, automatic waiting on short rate-limit back-offs, clear reset times for long ones, and token redaction on every output path.

---

## 2. Prerequisites

- **Node.js 20 or newer** (`node -v`)
- A **Cloudflare account** (free): <https://dash.cloudflare.com/sign-up>
- A **GitHub account**
- A **Claude plan with custom connectors** (Free, Pro, Max, Team or Enterprise — Free is limited to one custom connector). On Team/Enterprise, an owner may need to add the connector in admin settings.

## 3. Install dependencies

```bash
cd github-mcp-server
npm install
```

## 4. Create a GitHub Personal Access Token

A **fine-grained token** is recommended — you choose exactly which repositories and permissions it has.

1. Open <https://github.com/settings/personal-access-tokens/new> (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → *Generate new token*).
2. **Token name**: e.g. `claude-mcp`. **Expiration**: your choice (you can rotate later, see §16).
3. **Resource owner**: your account, or an organization (the org may need to approve fine-grained tokens).
4. **Repository access**: *All repositories*, or *Only select repositories* for tighter control.
5. Set **permissions** (next section), then **Generate token** and copy it (it starts with `github_pat_`). You will paste it in step 7.

A **classic token** (`ghp_…`, scopes such as `repo`, `workflow`, `delete_repo`, `notifications`, `gist`, `read:org`) also works and is required for the notifications tools, but it is broader and cannot be limited to specific repositories.

## 5. Choose token permissions

Grant only what you need. Read-only permissions are enough for reading code, searching and reviewing; **a read-only token cannot create, edit, commit, merge or delete anything** — those calls return a `403` with a hint telling Claude which permission is missing (GitHub's `X-Accepted-GitHub-Permissions` header is passed through as `accepted_permissions`).

**Recommended starting set (fine-grained, repository permissions)**

| Permission | Level | Needed for |
|---|---|---|
| Metadata | Read (always on) | Everything |
| Contents | Read and write | Read/write files, commits, branches, tags, releases, merges, compare |
| Pull requests | Read and write | Create/update/review/merge PRs |
| Issues | Read and write | Issues, comments, labels, milestones |
| Workflows | Read and write | Only if Claude should edit files under `.github/workflows/` |
| Actions | Read and write | List runs, read logs (read); trigger, cancel, re-run (write) |
| Commit statuses | Read | CI status on commits/PRs |

**Optional, add only if you want the feature**

| Permission | Level | Needed for |
|---|---|---|
| Administration | Read and write | Create (in orgs)/delete/archive/transfer repositories, settings, branch protection, collaborators, branch rename |
| Webhooks | Read and write | Webhook tools |
| Discussions | Read and write | Discussions tools |
| Checks | Read | Check runs in CI status (if your token type offers it; otherwise only commit statuses are shown) |
| *Account* → Gists | Read and write | Gist tools |
| *Organization* → Members | Read | Organization members and teams |

Creating a repository in your personal account works with *All repositories* access plus Administration: write. Notifications are only available to classic tokens (GitHub limitation).

## 6. Log in to Cloudflare

```bash
npx wrangler login
```

A browser window opens; approve access. (`npx wrangler whoami` shows the logged-in account.)

## 7. Add `GITHUB_TOKEN` as a Worker Secret

```bash
npx wrangler secret put GITHUB_TOKEN
```

Paste the token when prompted (input is hidden). If Wrangler says the Worker doesn't exist yet and asks to create it, answer **Y**. The token is encrypted by Cloudflare, never stored in this project, never logged and never returned by any tool.

## 8. Deploy

```bash
npm run deploy
```

This runs `scripts/deploy.mjs`, which:

1. checks you are logged in to Cloudflare,
2. runs `wrangler deploy` and reads the real Worker URL from Wrangler's output,
3. checks that `GITHUB_TOKEN` is set (and tells you if not),
4. creates the `MCP_ACCESS_KEY` secret the first time (random 256-bit key) and saves your endpoint in `.mcp-connection.json` (git-ignored, readable only by you),
5. calls the live endpoint: health check → MCP `initialize` → `get_authenticated_user`, so you can see that the transport **and** your GitHub token work,
6. prints your MCP endpoint.

The first deploy on a brand-new Cloudflare account may ask you to choose a `workers.dev` subdomain.

## 9. Find your MCP endpoint

It is printed at the end of `npm run deploy`, and you can show it again at any time:

```bash
npm run endpoint
```

It looks like `https://github-mcp-server.<your-subdomain>.workers.dev/mcp/<long-random-key>` — the host comes from your Cloudflare account; nothing is hard-coded. Opening the Worker's root URL (`https://github-mcp-server.<your-subdomain>.workers.dev/`) in a browser shows a status page (no secrets) with the tool count and whether the token is configured.

## 10. Connect it to Claude

**Claude (web, desktop, mobile)**

1. Open **Settings → Connectors** (called **Customize → Connectors** in some versions of the desktop app). On Team/Enterprise, an owner can add it for the organization under **Admin settings → Connectors**.
2. Click **Add custom connector**.
3. Name: `GitHub`. Remote MCP server URL: paste the full endpoint from step 9. Leave the OAuth fields empty.
4. Click **Add**. Claude connects and lists the tools.
5. In a chat, open the **+** menu → **Connectors** and make sure the connector is enabled for that conversation.

Claude reaches the server from Anthropic's cloud, so the Worker must be deployed (a `localhost` URL will not work here). Claude asks for your approval before using tools; write and destructive tools are marked as such.

**Claude Code** (supports headers, so the key can stay out of the URL):

```bash
claude mcp add --transport http github https://github-mcp-server.<sub>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

(or simply use the full `/mcp/<key>` URL without the header).

**MCP Inspector** (for testing): `npx @modelcontextprotocol/inspector@latest`, transport *Streamable HTTP*, URL = your endpoint.

## 11. Using the tools

Just ask. Examples that work out of the box:

| You say | What Claude does |
|---|---|
| "Create a private repository called my-project." | `create_repository` (private, initialised with a README) |
| "Find the repository with my portfolio website." | `search_repositories` (`portfolio user:<you>`) or `list_repositories` |
| "Create a branch called feature/dashboard." | `create_branch` from the default branch |
| "Read the README from the main branch." | `get_file_contents` with `ref: main` |
| "Create a TypeScript file under src/utils … commit it with 'Add dashboard utilities' and push to the feature branch." | `commit_files` (one commit, pushed immediately) |
| "Update this file with the code I provided." | `get_file_contents` → `create_or_update_file` (uses the file's `sha` to avoid overwriting newer changes) |
| "Compare my feature branch with main." | `compare_branches_or_commits` |
| "Open a pull request into main." | `create_pull_request` |
| "Show me the latest commits." | `list_commits` |
| "Find all my repositories that use `parseDate`." | `search_code` (`parseDate user:<you>`) |
| "Find and fix the bug in utils/date.ts." | `get_file_contents` → reasoning → `commit_files` (optionally on a new branch + PR) |
| "Delete the obsolete config file." | `delete_file` |
| "Which of my repos haven't been updated in a year?" | `list_repositories` sorted by `pushed` ascending |
| "Why did CI fail on PR #12?" | `get_pull_request_checks` → `get_failed_job_logs` |

Good to know:

- **Commit = push.** `create_or_update_file`, `delete_file`, `commit_files`, `move_file` and `revert_commit` create a commit and move the branch immediately. There is no local working copy and no separate push step.
- **Default branch.** When you don't name a branch, the repository's default branch is used.
- **New branch + commit in one step.** `commit_files` with `branch: "feature/x"` and `create_branch_from: "main"`.
- **Destructive actions need confirmation.** Deleting repositories/branches/refs/releases/webhooks/gists, archiving, transferring, force-moving refs and removing protection require a `confirm` argument equal to the target's name. If Claude calls without it, the server refuses and explains what is needed — so Claude has to ask you first. (MCP elicitation isn't used because Claude's connectors don't support it yet.)
- **Errors are explained.** Every error includes `status`, GitHub's `message` and a `hint` (e.g. "token lacks permission X", "branch moved, re-read and retry", "rate limit resets at …"), so Claude can decide what to do next.
- **Large outputs are bounded.** File reads, diffs and logs are truncated with a clear marker; use `start_line`/`end_line`, `per_page`/`page` or paths to narrow down.

## 12. Tool reference

148 tools. "needs confirm" = the tool refuses unless `confirm` matches the target (see above).

### `context` (5)

| Tool | What it does | Access |
|---|---|---|
| `get_authenticated_user` | Return the GitHub account the server's token belongs to (login, name, plan) plus token information. | read |
| `get_rate_limit` | Show remaining GitHub API quota (core REST, search, code search, GraphQL) and when each resets. | read |
| `get_user` | Get public profile information for any GitHub user or organization by login. | read |
| `get_github_meta` | Return GitHub instance metadata (API version info, SSH key fingerprints, and optionally the IP ranges GitHub uses for hooks, Actions, etc.). | read |
| `graphql_query` | Run a GitHub GraphQL query for data the other tools don't cover; mutations only with allow_mutation. | write ⚠️ destructive |

### `repos` (15)

| Tool | What it does | Access |
|---|---|---|
| `list_repositories` | List your repositories (or a user's/org's), sortable by last push — good for finding stale repos. | read |
| `get_repository` | Get a repository's details and settings: default branch, visibility, merge settings, topics, license, your permissions, timestamps and URLs. | read |
| `get_repository_languages` | Return the languages used in a repository with byte counts and percentages. | read |
| `create_repository` | Create a new repository for the authenticated user, or inside an organization when 'org' is set. | write |
| `fork_repository` | Fork a repository into your account or an organization. | write |
| `update_repository` | Change repository settings: description, homepage, visibility, default branch, features (issues/wiki/projects/discussions) and merge options. | write |
| `replace_repository_topics` | Replace all topics of a repository with the given list (pass an empty list to clear). | write |
| `archive_repository` | Archive (make read-only) or unarchive a repository. | write ⚠️ destructive (needs confirm) |
| `delete_repository` | Permanently delete a repository with all its code, issues, pull requests and releases. | write ⚠️ destructive (needs confirm) |
| `transfer_repository` | Transfer a repository to another user or organization. | write ⚠️ destructive (needs confirm) |
| `list_collaborators` | List users with access to a repository and their permission level. | read |
| `list_contributors` | List contributors to a repository sorted by number of commits. | read |
| `get_collaborator_permission` | Get the permission level (admin, maintain, write, triage, read, none) a user has on a repository. | read |
| `add_collaborator` | Invite a user to a repository (or change their permission). | write |
| `remove_collaborator` | Remove a user's access to a repository. | write ⚠️ destructive (needs confirm) |

### `files` (11)

| Tool | What it does | Access |
|---|---|---|
| `get_file_contents` | Read a file's text content from a repository at any branch, tag or commit (default: the default branch). | read |
| `list_directory` | List files and folders directly inside a directory (non-recursive). | read |
| `get_repository_tree` | Return the repository's file tree (recursive) at a branch, tag or commit, optionally limited to a sub-directory. | read |
| `search_files` | Find files in ONE repository whose path matches a pattern. | read |
| `get_file_metadata` | Get a file's metadata without its content: blob sha, size, type, URLs and the last commit that changed it. | read |
| `get_file_history` | List the commits that changed a specific file or directory, newest first. | read |
| `get_file_blame` | Show which commit last changed each line range of a file (git blame), via GitHub GraphQL. | read |
| `create_or_update_file` | Create a new file or replace an existing file's full content on a branch. | write |
| `delete_file` | Delete a single file from a branch with a commit (pushed immediately). | write ⚠️ destructive |
| `commit_files` | Create ONE commit that adds, updates and/or deletes any number of files, and push it to a branch (the branch on GitHub moves to the new commit immediately — this is the 'push'). | write |
| `move_file` | Rename/move a file — or a whole directory — within a repository in a single commit, preserving content exactly (equivalent to 'git mv' + commit + push). | write |

### `git` (15)

| Tool | What it does | Access |
|---|---|---|
| `list_commits` | List commits on a branch (default: default branch), newest first. | read |
| `get_commit` | Get a commit's message, author, parents, stats and changed files with diffs. | read |
| `compare_branches_or_commits` | Compare two refs (branches, tags or SHAs): shows whether head is ahead/behind base, the commits in head not in base, and the changed files/diff. | read |
| `revert_commit` | Create a new commit that undoes a previous (non-merge) commit, like 'git revert', and push it to a branch (or to a new branch for a pull request). | write |
| `get_commit_status_checks` | Get the combined CI result for a commit/branch: commit statuses and GitHub check runs (Actions etc.) with an overall passing/failing/pending verdict. | read |
| `list_refs` | List git references matching a prefix, e.g. | read |
| `get_ref` | Get what a single reference points to, e.g. | read |
| `create_ref` | Create a branch or tag reference pointing at a commit SHA. | write |
| `update_ref` | Point a branch/tag reference at another commit. | write ⚠️ destructive (needs confirm) |
| `delete_ref` | Delete a branch or tag reference. | write ⚠️ destructive (needs confirm) |
| `get_blob` | Read a git blob (file content) by its SHA. | read |
| `create_blob` | Low-level: store file content as a git blob and get its SHA, for use with create_tree. | write |
| `get_tree` | Read a git tree object by tree SHA, commit SHA or branch name. | read |
| `create_tree` | Low-level: create a tree object. | write |
| `create_git_commit` | Low-level: create a commit object from a tree SHA and parent SHAs. | write |

### `branches` (10)

| Tool | What it does | Access |
|---|---|---|
| `list_branches` | List a repository's branches with their head commit SHA and whether they are protected. | read |
| `get_branch` | Get a branch's head commit (SHA, message, author, date) and protection state. | read |
| `create_branch` | Create a new branch from another branch, tag or commit (default: the repository's default branch). | write |
| `rename_branch` | Rename a branch. | write |
| `delete_branch` | Delete a branch. | write ⚠️ destructive (needs confirm) |
| `merge_branch` | Merge a branch/commit directly into a base branch without a pull request (creates a merge commit on base, or fast-forwards nothing if already merged). | write |
| `sync_fork_branch` | Update a branch of a forked repository with the latest changes from the upstream (parent) repository, like the 'Sync fork' button. | write |
| `get_branch_protection` | Show branch protection settings (required reviews, status checks, admin enforcement, force-push/deletion rules). | read |
| `update_branch_protection` | Create or replace classic branch protection for a branch. | write ⚠️ destructive |
| `delete_branch_protection` | Remove classic branch protection from a branch. | write ⚠️ destructive (needs confirm) |

### `pulls` (16)

| Tool | What it does | Access |
|---|---|---|
| `list_pull_requests` | List pull requests in a repository, filtered by state, base branch or head branch. | read |
| `get_pull_request` | Get a pull request's description, state, head/base branches and SHAs, mergeability, review requests and change stats. | read |
| `create_pull_request` | Open a pull request to merge 'head' into 'base' (e.g. | write |
| `update_pull_request` | Edit a pull request's title, body or base branch, or close (state 'closed') / reopen (state 'open') it. | write |
| `merge_pull_request` | Merge a pull request using 'merge', 'squash' or 'rebase'. | write |
| `get_pull_request_diff` | Get the complete unified diff of a pull request as text (truncated for very large PRs; use list_pull_request_files for per-file patches). | read |
| `list_pull_request_files` | List the files a pull request changes with additions/deletions and optional per-file patches. | read |
| `list_pull_request_commits` | List the commits included in a pull request (oldest first). | read |
| `get_pull_request_checks` | Get the CI status (check runs and commit statuses) for a pull request's latest head commit, with an overall passing/failing/pending verdict. | read |
| `create_pull_request_review` | Submit a review: APPROVE, REQUEST_CHANGES (body required) or COMMENT, optionally with inline comments on specific lines. | write |
| `list_pull_request_reviews` | List the review history of a pull request: who approved, requested changes or commented, and when. | read |
| `list_pull_request_review_comments` | List inline (line-level) review comments on a pull request, including the file path, line and the comment thread they belong to. | read |
| `add_pull_request_review_comment` | Add a single inline comment on a line of a pull request's diff, or reply to an existing review comment (in_reply_to). | write |
| `request_pull_request_reviewers` | Request reviews on a pull request from users and/or teams (team slugs). | write |
| `update_pull_request_branch` | Merge the latest base branch into the pull request's head branch (the 'Update branch' button). | write |
| `set_pull_request_draft` | Mark a draft pull request as ready for review (draft: false), or convert a pull request back to a draft (draft: true). | write |

### `issues` (20)

| Tool | What it does | Access |
|---|---|---|
| `list_issues` | List issues in a repository filtered by state, labels, assignee, creator or update time. | read |
| `get_issue` | Get an issue's full details including its body. | read |
| `create_issue` | Create a new issue. | write |
| `update_issue` | Edit an issue: title, body, close/reopen (state), close reason, labels (REPLACES all labels), assignees (REPLACES all) or milestone. | write |
| `add_issue_assignees` | Add assignees to an issue or pull request (keeps existing assignees). | write |
| `remove_issue_assignees` | Remove assignees from an issue or pull request. | write |
| `add_issue_labels` | Add labels to an issue or pull request (keeps existing labels). | write |
| `remove_issue_label` | Remove one label from an issue or pull request. | write |
| `list_issue_comments` | List the conversation comments on an issue or pull request (oldest first). | read |
| `add_issue_comment` | Add a comment to an issue or a pull request's conversation (use the PR number as issue_number). | write |
| `update_issue_comment` | Replace the text of an existing issue/PR conversation comment. | write |
| `delete_issue_comment` | Delete an issue/PR conversation comment by its comment ID (from list_issue_comments). | write ⚠️ destructive |
| `list_labels` | List the labels defined in a repository (name, color, description). | read |
| `create_label` | Create a repository label that can then be added to issues and pull requests. | write |
| `update_label` | Rename a label or change its color/description. | write |
| `delete_label` | Delete a label from the repository (it is removed from all issues and PRs). | write ⚠️ destructive |
| `list_milestones` | List milestones with their open/closed issue counts and due dates. | read |
| `create_milestone` | Create a milestone. | write |
| `update_milestone` | Change a milestone's title, description, due date, or close/reopen it. | write |
| `delete_milestone` | Delete a milestone (issues keep existing but lose the milestone). | write ⚠️ destructive |

### `discussions` (6)

| Tool | What it does | Access |
|---|---|---|
| `list_discussion_categories` | List a repository's discussion categories with their IDs (needed by create_discussion). | read |
| `list_discussions` | List discussions in a repository, newest first, optionally in one category. | read |
| `get_discussion` | Get a discussion's body and its comments (with replies). | read |
| `create_discussion` | Create a new discussion in a category (get category_id from list_discussion_categories). | write |
| `add_discussion_comment` | Add a comment to a discussion, or reply to an existing comment (reply_to_comment_id from get_discussion). | write |
| `close_discussion` | Close a discussion (reason RESOLVED, OUTDATED or DUPLICATE) or reopen it. | write |

### `search` (7)

| Tool | What it does | Access |
|---|---|---|
| `search_repositories` | Search GitHub repositories by name, description, topic, language, owner, stars, etc. | read |
| `search_code` | Search file CONTENTS across GitHub (default branches only, files under 384 KB). | read |
| `search_commits` | Search commit messages and metadata. | read |
| `search_issues` | Search issues across repositories (pull requests excluded automatically). | read |
| `search_pull_requests` | Search pull requests across repositories. | read |
| `search_users` | Search GitHub users/organizations. | read |
| `search_topics` | Search GitHub topics (the tags repositories use), e.g. | read |

### `actions` (14)

| Tool | What it does | Access |
|---|---|---|
| `list_workflows` | List the GitHub Actions workflows defined in a repository (name, file path, state). | read |
| `get_workflow` | Get a workflow's details (ID, name, path, state). | read |
| `run_workflow` | Trigger a workflow that has an 'on: workflow_dispatch' trigger, on a branch or tag, with optional inputs. | write |
| `list_workflow_runs` | List recent workflow runs for the whole repository or one workflow, filtered by branch, event, status (e.g. | read |
| `get_workflow_run` | Get the status and conclusion of a workflow run, plus a summary of its jobs. | read |
| `list_workflow_run_jobs` | List the jobs (with steps) of a workflow run. | read |
| `get_job` | Get one job's status, conclusion, runner and steps. | read |
| `get_job_logs` | Download the log output of one workflow job (last tail_lines lines by default, since errors are usually at the end). | read |
| `get_failed_job_logs` | For a workflow run, find the failed jobs and return the tail of each one's log — the quickest way to see why CI failed. | read |
| `cancel_workflow_run` | Cancel a queued or in-progress workflow run. | write |
| `rerun_workflow_run` | Re-run a completed workflow run — all jobs, or only the failed ones (only_failed: true). | write |
| `rerun_job` | Re-run one job of a workflow run (and jobs that depend on it). | write |
| `list_workflow_run_artifacts` | List the artifacts a workflow run uploaded (name, size, expiry). | read |
| `set_workflow_enabled` | Enable or disable a workflow so it does or does not run on its triggers. | write |

### `releases` (12)

| Tool | What it does | Access |
|---|---|---|
| `list_releases` | List releases (including drafts if you have push access), newest first. | read |
| `get_release` | Get a release with its notes and assets — by release_id, by tag, or the latest published release (omit both). | read |
| `create_release` | Create a release for a tag. | write |
| `update_release` | Edit a release's tag, title, notes, draft/prerelease flags. | write |
| `publish_release` | Publish a draft release (makes it public and notifies watchers). | write |
| `delete_release` | Delete a release and its uploaded assets (the git tag is kept unless delete_tag is true). | write ⚠️ destructive (needs confirm) |
| `list_release_assets` | List the files (assets) attached to a release, with download URLs. | read |
| `upload_release_asset` | Attach a file to a release. | write |
| `delete_release_asset` | Delete a file attached to a release. | write ⚠️ destructive (needs confirm) |
| `list_tags` | List the repository's git tags with the commit each points to. | read |
| `get_tag` | Inspect a tag reference: whether it is lightweight or annotated, the tagger and message (annotated), and the commit it points to. | read |
| `create_tag` | Create a git tag on a commit/branch (default: default branch head). | write |

### `webhooks` (5)

| Tool | What it does | Access |
|---|---|---|
| `list_repository_webhooks` | List a repository's webhooks (target URL, events, active, last delivery result). | read |
| `create_repository_webhook` | Create a webhook that POSTs repository events to a URL. | write |
| `update_repository_webhook` | Change a webhook's URL, events, content type, secret or active state. | write |
| `ping_repository_webhook` | Send a 'ping' event to a webhook to test delivery. | write |
| `delete_repository_webhook` | Delete a repository webhook. | write ⚠️ destructive (needs confirm) |

### `gists` (5)

| Tool | What it does | Access |
|---|---|---|
| `list_gists` | List your gists, or another user's public gists. | read |
| `get_gist` | Get a gist with the content of its files (files over ~1 MB are truncated; use raw_url). | read |
| `create_gist` | Create a gist with one or more files. | write |
| `update_gist` | Update a gist's description or files. | write |
| `delete_gist` | Delete a gist permanently. | write ⚠️ destructive (needs confirm) |

### `notifications` (2)

| Tool | What it does | Access |
|---|---|---|
| `list_notifications` | List your GitHub notifications (review requests, mentions, assignments, CI…), optionally for one repository. | read |
| `mark_notifications_read` | Mark one notification thread (thread_id), all notifications in a repository (owner+repo), or all notifications as read. | write |

### `orgs` (5)

| Tool | What it does | Access |
|---|---|---|
| `list_my_organizations` | List organizations the authenticated user belongs to (fine-grained tokens only see organizations they were granted access to). | read |
| `get_organization` | Get an organization's profile and settings visible to you. | read |
| `list_organization_members` | List members of an organization, optionally filtered by role. | read |
| `list_organization_teams` | List teams in an organization (slug, name, privacy). | read |
| `list_team_repositories` | List the repositories an organization team has access to. | read |

## 13. Configuration

Non-secret settings live in `wrangler.jsonc` → `vars`. Change them and run `npm run deploy` again.

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_TOOLSETS` | `all` | Comma-separated toolsets to expose, e.g. `repos,files,branches,pulls,issues,search`. `context` is always included. |
| `GITHUB_READ_ONLY` | `false` | `true` hides every tool that can change anything (74 read-only tools remain). |
| `GITHUB_API_URL` | `https://api.github.com` | For GitHub Enterprise Server use `https://HOST/api/v3` (GraphQL URL is derived). |
| `ALLOW_UNAUTHENTICATED_MCP` | `false` | `true` disables the access key. Only do this if something else (e.g. Cloudflare Access) protects the Worker. |

**Tool list size.** All 148 tool definitions add up to about 136 KB of JSON (roughly 35k tokens of Claude's context). If you mostly do code work, a smaller set such as `GITHUB_TOOLSETS="repos,files,git,branches,pulls,issues,search"` (99 tools, ~98 KB) keeps the context leaner.

**Workers Free CPU limit.** The free plan allows 10 ms of CPU per request. Tool calls use a few ms, but answering `tools/list` with all 148 tools measured about 9 ms in a local benchmark (JSON Schemas are pre-built once per isolate to keep this low) — close to the limit. If the connector ever fails to load its tools with Cloudflare error 1102 ("Worker exceeded resource limits"), either narrow `GITHUB_TOOLSETS` as above or switch the account to Workers Paid ($5/month, 30 s default CPU).

Secrets:

| Secret | Set with |
|---|---|
| `GITHUB_TOKEN` | `npx wrangler secret put GITHUB_TOKEN` |
| `MCP_ACCESS_KEY` | created by `npm run deploy`; replace with `npm run rotate-key` |

## 14. Security model

- **Token storage.** `GITHUB_TOKEN` is a Cloudflare Worker Secret. It is only ever placed in the `Authorization` header of requests to the GitHub API host. It is never logged; error messages and tool results pass through a redaction filter that removes the token and anything token-shaped. Signed log-download URLs that GitHub redirects to are fetched **without** the token.
- **Endpoint protection.** Requests without the correct `MCP_ACCESS_KEY` get `401`; if the key secret is missing, the endpoint fails closed (`503`). Keys are compared in constant time. The key travels in the URL path (over HTTPS); it can appear in your own Cloudflare request logs, which only your account can see. Rotate it with `npm run rotate-key` if it leaks.
- **Least privilege.** Use a fine-grained token limited to the repositories Claude should touch, with the permissions in §5. Consider `GITHUB_READ_ONLY=true` for review-only use.
- **Destructive operations** require explicit confirmation values and are annotated `destructiveHint: true`; the default branch can't be deleted; ref updates are fast-forward only unless forced with confirmation; `commit_files` refuses to overwrite a branch that moved meanwhile.
- **Input validation.** Every tool validates arguments (owner/repo/path/SHA formats, enums, sizes) before calling GitHub; path traversal segments (`..`) are rejected.
- **Browser access.** The SDK handler validates `Origin`/`Host` headers (DNS-rebinding protection); Claude's server-side requests are unaffected.

## 15. Troubleshooting

| Symptom | Fix |
|---|---|
| `npm run deploy` says you're not logged in | `npx wrangler login` |
| Deploy output has no URL | Find the Worker in the Cloudflare dashboard → Workers & Pages, then `npm run endpoint -- --url=https://<worker-url>` |
| Error `server_not_configured` / "GITHUB_TOKEN is not configured" | `npx wrangler secret put GITHUB_TOKEN` (no redeploy needed) |
| `401 … token was rejected` | Token expired/revoked or mistyped. Create a new one and run `npx wrangler secret put GITHUB_TOKEN` again. |
| `403 … not allowed`, with `accepted_permissions` | Add that permission to the fine-grained token (and make sure the repository is selected). Org repos may also need the org to approve the token or SSO authorization. |
| `404` for a repository you own | Fine-grained token doesn't include that repository, or the name is wrong. GitHub returns 404 (not 403) for private repos the token can't see. |
| Claude: "couldn't connect" / 401 from the endpoint | The URL must include `/mcp/<key>` exactly as printed by `npm run endpoint`. If you lost it, `npm run rotate-key` and update the connector. |
| `MCP_ACCESS_KEY exists … no saved copy` | You deployed from another computer. Reuse your old URL, or `npm run rotate-key`. |
| Endpoint returns `503` "MCP_ACCESS_KEY is not configured" | Run `npm run deploy` (it creates the key). |
| `rate_limited` errors | Wait until the reset time shown. Code search is limited to ~10 requests/minute. `get_rate_limit` shows quotas. |
| `409` from `commit_files` / `create_or_update_file` | Someone pushed in the meantime or the `sha` is stale. Ask Claude to re-read the file and retry. |
| Can't edit `.github/workflows/*` | Give the token **Workflows: write** (classic: `workflow` scope). |
| Notifications tools return 403 | GitHub supports them only for classic tokens. |
| Check the live server end-to-end | `npm run smoke` (read-only checks). `npm run smoke -- --repo=you/scratch-repo` also runs a full write cycle (branch → commit → PR → close → delete branch) in a throwaway repo. |
| Connector fails to list tools, logs show error 1102 / "exceeded resource limits" | Workers Free CPU limit (10 ms). Set a smaller `GITHUB_TOOLSETS` in `wrangler.jsonc` and redeploy, or use Workers Paid (see §13). |
| See server logs | Cloudflare dashboard → Workers & Pages → github-mcp-server → Logs, or `npx wrangler tail`. |

## 16. Updating and redeploying

- **Change code or settings:** edit, then `npm run deploy`. The endpoint URL stays the same.
- **Update dependencies:** `npm update && npm run check && npm run deploy`.
- **Rotate the GitHub token:** create a new token, `npx wrangler secret put GITHUB_TOKEN`. Takes effect immediately; nothing to change in Claude.
- **Rotate the endpoint key:** `npm run rotate-key`, then update the URL in Claude's connector settings.
- **Remove everything:** `npx wrangler delete`, delete the connector in Claude, and revoke the token on GitHub.

## 17. Development and tests

```bash
cp .dev.vars.example .dev.vars   # put a token and any local key in it
npm run dev                      # http://localhost:8787/mcp/<MCP_ACCESS_KEY from .dev.vars>
npm run smoke -- --endpoint=http://localhost:8787/mcp/<key>
npm run check                    # typecheck + tests + wrangler bundle dry-run
```

Automated tests (`npm test`, Vitest) need no network or token. A real MCP SDK client talks to the Worker's fetch handler over Streamable HTTP, and the Worker talks to a scripted fake GitHub API. They cover: initialization on the 2025-06-18, 2025-11-25 and 2026-07-28 protocol revisions; tool discovery; access-key auth; read-only mode; reading/decoding files; create/update with automatic `sha`; multi-file commits incl. deletes, executable bits, new branches, and concurrent-push detection; moves; branch create/delete with confirmation; compare; PR create/merge; revert (success and conflict); invalid token, missing token, missing permissions, rate limits, retries; token redaction; and deploy URL parsing.

Project layout:

```
src/
  index.ts          Worker entry: routing, access-key check, createMcpHandler
  server.ts         Builds the MCP server, registers tools, formats results/errors
  auth.ts           MCP endpoint access key (constant-time compare)
  config.ts         Toolsets, read-only mode, API URLs
  github/
    client.ts       REST/GraphQL client: retries, rate limits, pagination, redaction
    gitops.ts       Commit/push via Git Data API, tree helpers, globbing
    compact.ts      Trims verbose GitHub JSON for Claude
    encoding.ts     UTF-8 safe base64, binary detection
    errors.ts       Typed errors with hints
  tools/            One file per area; each tool = name, description, Zod schema, handler
scripts/
  deploy.mjs        npm run deploy / endpoint / rotate-key
  smoke-test.mjs    npm run smoke (live end-to-end check)
test/               Vitest suites + fake GitHub + MCP client helpers
```

Adding a tool: add a `defineTool({...})` entry to the right file in `src/tools/` (it is registered automatically), then add a test.

## 18. Limitations

- **No local git.** Operations use GitHub's APIs. There is no clone, working tree, rebase, cherry-pick, stash, interactive staging, `git blame -C`, submodule updates, or LFS uploads. Merges happen via `merge_branch` / `merge_pull_request` (server-side), not locally.
- **Revert** works for non-merge commits touching fewer than 300 files, and refuses (changing nothing) if any affected file changed afterwards. Merge commits: use GitHub's "Revert" button on the PR.
- **Large repositories:** tools that read the full tree (`search_files`, `get_repository_tree`, `move_file`, `revert_commit`, `commit_files` safety checks) depend on GitHub's recursive tree API, which truncates at very large sizes; the tools say so when it happens.
- **File sizes:** reads up to GitHub's 100 MB raw limit (output truncated for Claude); writes are limited by MCP request size — fine for source code, not for large binaries.
- **Search** is GitHub search: default branches only for code search, max 1000 results, code search ~10 requests/minute.
- **Workflow run logs:** per-job logs only (`get_job_logs`, `get_failed_job_logs`); the zipped full-run archive and artifacts are not downloaded.
- **Notifications** require a classic token. **Branch protection** tools manage classic protection; repository rulesets are shown read-only.
- **Release asset uploads** are limited by the MCP request size (a few MB is safe).
- **Cloudflare free plan** allows 50 outbound requests and 10 ms CPU per request. Tools stay well below 50 GitHub calls (a multi-file commit uses about 7, plus one per base64/binary file, capped at 40); the full 148-tool list is close to the CPU limit (see §13).
- **Elicitation-based confirmation** isn't used because Claude's connectors don't support it yet; confirmation is enforced through the `confirm` argument plus Claude's own tool-approval prompts.

## License

MIT
