/**
 * End-to-end tests: a real MCP SDK client talks to the Worker's fetch handler
 * (Streamable HTTP), and the Worker talks to a scripted fake GitHub API.
 */
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/tools/index";
import { utf8ToBase64 } from "../src/github/encoding";
import { FakeGitHub, TEST_KEY, TEST_TOKEN, connectClient, jsonResponse, rawRpc, resultJson, resultText, testEnv, workerFetch } from "./helpers";

const BASE = "/repos/octo/app";

/** A tiny fake repository with one branch, for git-data operations. */
function fakeRepo(fake = new FakeGitHub()) {
  return fake
    .on("GET", `${BASE}`, () => ({ full_name: "octo/app", default_branch: "main", private: true }))
    .on("GET", `${BASE}/git/ref/heads/main`, () => ({ ref: "refs/heads/main", object: { sha: "c0ffee0000000000000000000000000000000001", type: "commit" } }))
    .on("GET", /\/git\/ref\/heads\/feature\//, () => jsonResponse({ message: "Not Found" }, 404))
    .on("GET", `${BASE}/git/commits/c0ffee0000000000000000000000000000000001`, () => ({ sha: "c0ffee0000000000000000000000000000000001", tree: { sha: "tree000000000000000000000000000000000001" } }))
    .on("GET", `${BASE}/git/trees/tree000000000000000000000000000000000001`, () => ({
      sha: "tree000000000000000000000000000000000001",
      truncated: false,
      tree: [
        { path: "README.md", mode: "100644", type: "blob", sha: "b100000000000000000000000000000000000001", size: 10 },
        { path: "src", mode: "040000", type: "tree", sha: "t200000000000000000000000000000000000002" },
        { path: "src/index.ts", mode: "100644", type: "blob", sha: "b300000000000000000000000000000000000003", size: 20 },
        { path: "scripts/run.sh", mode: "100755", type: "blob", sha: "b400000000000000000000000000000000000004", size: 5 },
        { path: "old.config.json", mode: "100644", type: "blob", sha: "b500000000000000000000000000000000000005", size: 5 },
      ],
    }))
    .on("GET", `${BASE}/git/trees/c0ffee0000000000000000000000000000000001`, (c) => fake.fetch(`https://api.github.com${BASE}/git/trees/tree000000000000000000000000000000000001`, { method: "GET" }))
    .on("POST", `${BASE}/git/trees`, () => ({ sha: "newtree000000000000000000000000000000001" }))
    .on("POST", `${BASE}/git/commits`, () => ({ sha: "newc0mmit00000000000000000000000000000001", html_url: "https://github.com/octo/app/commit/newc0mmit" }))
    .on("PATCH", `${BASE}/git/refs/heads/main`, (c) => ({ ref: "refs/heads/main", object: { sha: (c.body as { sha: string }).sha } }))
    .on("POST", `${BASE}/git/refs`, (c) => jsonResponse({ ref: (c.body as { ref: string }).ref, object: { sha: (c.body as { sha: string }).sha } }, 201));
}

describe("MCP protocol over Streamable HTTP", () => {
  it("initializes and lists every tool with schemas and annotations", async () => {
    const client = await connectClient(testEnv(), new FakeGitHub());
    const { tools } = await client.listTools();
    expect(tools.length).toBe(ALL_TOOLS.length);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations).toBeDefined();
    }
    const del = tools.find((t) => t.name === "delete_repository")!;
    expect(del.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "get_file_contents")!.annotations?.readOnlyHint).toBe(true);
    expect(client.getServerVersion()?.name).toBe("github-mcp-server");
    await client.close();
  });

  it("also serves clients on the stateless 2026-07-28 protocol revision", async () => {
    const fake = new FakeGitHub().on("GET", "/user", () => ({ login: "octo" }));
    const client = await connectClient(testEnv(), fake, { modern: true });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(ALL_TOOLS.length);
    const r = await client.callTool({ name: "get_authenticated_user", arguments: {} });
    expect(resultJson(r)).toMatchObject({ user: { login: "octo" } });
    await client.close();
  });

  it("serves legacy (2025-era) clients that use an initialize handshake", async () => {
    const env = testEnv();
    const init = await rawRpc(env, new FakeGitHub(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect(init.message.result.protocolVersion).toBe("2025-06-18");
    expect(init.message.result.capabilities.tools).toBeDefined();
    const list = await rawRpc(env, new FakeGitHub(), { jsonrpc: "2.0", id: 2, method: "tools/list" }, `/mcp/${TEST_KEY}`, { "mcp-protocol-version": "2025-06-18" });
    expect(list.message.result.tools.length).toBe(ALL_TOOLS.length);
  });

  it("accepts the access key as a bearer header on /mcp", async () => {
    const r = await rawRpc(testEnv(), new FakeGitHub(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, "/mcp", {
      authorization: `Bearer ${TEST_KEY}`,
      "mcp-protocol-version": "2025-06-18",
    });
    expect(r.status).toBe(200);
  });

  it("rejects a wrong access key and locks the endpoint when no key is configured", async () => {
    const wrong = await rawRpc(testEnv(), new FakeGitHub(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, "/mcp/not-the-key");
    expect(wrong.status).toBe(401);
    const unset = await rawRpc(testEnv({ MCP_ACCESS_KEY: undefined }), new FakeGitHub(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, "/mcp/anything");
    expect(unset.status).toBe(503);
  });

  it("health endpoint reports configuration without secrets", async () => {
    const res = await workerFetch(testEnv(), new FakeGitHub())("https://github-mcp-server.example.workers.dev/");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain(TEST_KEY);
    expect(JSON.parse(text)).toMatchObject({ status: "ok", github_token_configured: true, mcp_access_key_configured: true });
  });

  it("read-only mode hides every write tool", async () => {
    const client = await connectClient(testEnv({ GITHUB_READ_ONLY: "true" }), new FakeGitHub());
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "commit_files")).toBe(false);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });
});

describe("GitHub tools", () => {
  it("get_authenticated_user works and reports token kind", async () => {
    const fake = new FakeGitHub().on("GET", "/user", () => jsonResponse({ login: "octo", name: "Octo", plan: { name: "pro" } }, 200, { "github-authentication-token-expiration": "2027-01-01 00:00:00 UTC" }));
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "get_authenticated_user", arguments: {} });
    expect(r.isError).toBeFalsy();
    const body = resultJson(r);
    expect(body.user).toMatchObject({ login: "octo" });
    expect(String((body.token as Record<string, unknown>).kind)).toMatch(/fine-grained/);
    expect(r.structuredContent).toBeDefined();
    await client.close();
  });

  it("an invalid token produces a clear, token-free error", async () => {
    const fake = new FakeGitHub().on("GET", "/user", () => jsonResponse({ message: "Bad credentials" }, 401));
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "get_authenticated_user", arguments: {} });
    expect(r.isError).toBe(true);
    const text = resultText(r);
    expect(text).toContain("401");
    expect(text).toContain("wrangler secret put GITHUB_TOKEN");
    expect(text).not.toContain(TEST_TOKEN);
    await client.close();
  });

  it("a missing GITHUB_TOKEN secret is reported as a configuration problem", async () => {
    const client = await connectClient(testEnv({ GITHUB_TOKEN: undefined }), new FakeGitHub());
    const r = await client.callTool({ name: "list_repositories", arguments: {} });
    expect(r.isError).toBe(true);
    expect(resultJson(r)).toMatchObject({ error: { type: "server_not_configured" } });
    await client.close();
  });

  it("insufficient permissions explain which permission is needed", async () => {
    const fake = new FakeGitHub()
      .on("GET", "/repos/octo/app/contents/notes.txt", () => jsonResponse({ message: "Not Found" }, 404))
      .on("PUT", "/repos/octo/app/contents/notes.txt", () =>
        jsonResponse({ message: "Resource not accessible by personal access token" }, 403, { "x-accepted-github-permissions": "contents=write" }),
      );
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "create_or_update_file", arguments: { owner: "octo", repo: "app", path: "notes.txt", content: "hi", message: "add" } });
    expect(r.isError).toBe(true);
    expect(resultJson(r)).toMatchObject({ error: { status: 403, accepted_permissions: "contents=write" } });
    await client.close();
  });

  it("rate limits are reported with a reset time", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const fake = new FakeGitHub().on("GET", "/user/repos", () => jsonResponse({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }));
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "list_repositories", arguments: {} });
    expect(r.isError).toBe(true);
    expect(resultJson(r)).toMatchObject({ error: { type: "rate_limited", rate_limit_reset: new Date(reset * 1000).toISOString() } });
    await client.close();
  });

  it("lists repositories with pagination info", async () => {
    const fake = new FakeGitHub().on("GET", "/user/repos", (c) => {
      expect(c.url.searchParams.get("sort")).toBe("pushed");
      return jsonResponse([{ full_name: "octo/app", private: true, pushed_at: "2024-01-01T00:00:00Z", hooks_url: "x" }], 200, {
        link: '<https://api.github.com/user/repos?page=2>; rel="next"',
      });
    });
    const client = await connectClient(testEnv(), fake);
    const body = resultJson(await client.callTool({ name: "list_repositories", arguments: {} }));
    expect(body.repositories).toEqual([{ full_name: "octo/app", private: true, pushed_at: "2024-01-01T00:00:00Z" }]);
    expect(body.pagination).toMatchObject({ has_next_page: true, next_page: 2 });
    await client.close();
  });

  it("creates a private repository", async () => {
    const fake = new FakeGitHub().on("POST", "/user/repos", (c) => jsonResponse({ ...(c.body as object), full_name: "octo/my-project", default_branch: "main" }, 201));
    const client = await connectClient(testEnv(), fake);
    const body = resultJson(await client.callTool({ name: "create_repository", arguments: { name: "my-project" } }));
    expect(fake.calls[0].body).toMatchObject({ name: "my-project", private: true, auto_init: true });
    expect(body).toMatchObject({ created: true, repository: { full_name: "octo/my-project", private: true } });
    await client.close();
  });

  it("reads a file and decodes UTF-8 content", async () => {
    const content = "# Hello\nüñíçødé ✓\n";
    const fake = new FakeGitHub().on("GET", "/repos/octo/app/contents/README.md", (c) => {
      expect(c.url.searchParams.get("ref")).toBe("main");
      return { type: "file", name: "README.md", path: "README.md", sha: "abc123", size: 22, encoding: "base64", content: utf8ToBase64(content) };
    });
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "get_file_contents", arguments: { owner: "octo", repo: "app", path: "README.md", ref: "main" } });
    const text = resultText(r);
    expect(text).toContain("sha: abc123");
    expect(text.endsWith(content)).toBe(true);
    expect(r.structuredContent).toMatchObject({ path: "README.md", sha: "abc123" });
    await client.close();
  });

  it("create_or_update_file looks up the current sha so updates don't fail", async () => {
    const fake = new FakeGitHub()
      .on("GET", "/repos/octo/app/contents/src/utils/date.ts", () => ({ type: "file", path: "src/utils/date.ts", sha: "oldsha1", size: 3 }))
      .on("PUT", "/repos/octo/app/contents/src/utils/date.ts", () => ({ content: { sha: "newsha", html_url: "u" }, commit: { sha: "c1", html_url: "cu" } }));
    const client = await connectClient(testEnv(), fake);
    const body = resultJson(await client.callTool({ name: "create_or_update_file", arguments: { owner: "octo", repo: "app", path: "src/utils/date.ts", content: "export {};\n", message: "Update", branch: "dev" } }));
    const put = fake.callsTo("PUT", "/repos/octo/app/contents/src/utils/date.ts")[0];
    expect(put.body).toMatchObject({ sha: "oldsha1", branch: "dev", message: "Update", content: utf8ToBase64("export {};\n") });
    expect(body).toMatchObject({ action: "updated", commit_sha: "c1" });
    await client.close();
  });

  it("commit_files creates one commit with adds, updates and deletes, then pushes (moves the ref)", async () => {
    const fake = fakeRepo();
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({
      name: "commit_files",
      arguments: {
        owner: "octo",
        repo: "app",
        message: "Add dashboard utilities",
        files: [
          { path: "src/utils/dashboard.ts", content: "export const x = 1;\n" },
          { path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n" },
          { path: "old.config.json", delete: true },
        ],
      },
    });
    expect(r.isError).toBeFalsy();
    const tree = fake.callsTo("POST", `${BASE}/git/trees`)[0].body as { base_tree: string; tree: Array<Record<string, unknown>> };
    expect(tree.base_tree).toBe("tree000000000000000000000000000000000001");
    expect(tree.tree).toEqual([
      { path: "src/utils/dashboard.ts", mode: "100644", type: "blob", content: "export const x = 1;\n" },
      { path: "scripts/run.sh", mode: "100755", type: "blob", content: "#!/bin/sh\necho hi\n" }, // executable bit preserved
      { path: "old.config.json", mode: "100644", type: "blob", sha: null },
    ]);
    const commit = fake.callsTo("POST", `${BASE}/git/commits`)[0].body as Record<string, unknown>;
    expect(commit).toMatchObject({ message: "Add dashboard utilities", parents: ["c0ffee0000000000000000000000000000000001"] });
    const refUpdate = fake.callsTo("PATCH", `${BASE}/git/refs/heads/main`)[0].body;
    expect(refUpdate).toEqual({ sha: "newc0mmit00000000000000000000000000000001", force: false });
    expect(resultJson(r)).toMatchObject({ pushed: true, branch: "main", commit_sha: "newc0mmit00000000000000000000000000000001" });
    await client.close();
  });

  it("commit_files can create a new feature branch as part of the commit", async () => {
    const fake = fakeRepo().on("GET", `${BASE}/commits/main`, () => new Response("c0ffee0000000000000000000000000000000001", { status: 200 }));
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({
      name: "commit_files",
      arguments: { owner: "octo", repo: "app", branch: "feature/dashboard", create_branch_from: "main", message: "Start", files: [{ path: "a.txt", content: "a" }] },
    });
    expect(r.isError).toBeFalsy();
    expect(fake.callsTo("POST", `${BASE}/git/refs`)[0].body).toEqual({ ref: "refs/heads/feature/dashboard", sha: "newc0mmit00000000000000000000000000000001" });
    expect(resultJson(r)).toMatchObject({ created_branch: true, branch: "feature/dashboard" });
    await client.close();
  });

  it("commit_files refuses to delete a file that does not exist", async () => {
    const client = await connectClient(testEnv(), fakeRepo());
    const r = await client.callTool({ name: "commit_files", arguments: { owner: "octo", repo: "app", message: "x", files: [{ path: "nope.txt", delete: true }] } });
    expect(r.isError).toBe(true);
    expect(resultJson(r)).toMatchObject({ error: { type: "invalid_input" } });
    await client.close();
  });

  it("commit_files reports a concurrent push instead of overwriting", async () => {
    const fake = fakeRepo(new FakeGitHub().on("PATCH", `${BASE}/git/refs/heads/main`, () => jsonResponse({ message: "Update is not a fast forward" }, 422)));
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "commit_files", arguments: { owner: "octo", repo: "app", message: "x", files: [{ path: "a.txt", content: "a" }] } });
    expect(r.isError).toBe(true);
    expect(resultJson(r)).toMatchObject({ error: { status: 409 } });
    await client.close();
  });

  it("move_file renames by reusing the blob and deleting the old path in one commit", async () => {
    const fake = fakeRepo();
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "move_file", arguments: { owner: "octo", repo: "app", from_path: "src/index.ts", to_path: "src/main.ts" } });
    expect(r.isError).toBeFalsy();
    const tree = fake.callsTo("POST", `${BASE}/git/trees`)[0].body as { tree: unknown[] };
    expect(tree.tree).toEqual([
      { path: "src/main.ts", mode: "100644", type: "blob", sha: "b300000000000000000000000000000000000003" },
      { path: "src/index.ts", mode: "100644", type: "blob", sha: null },
    ]);
    await client.close();
  });

  it("create_branch creates a ref from the default branch", async () => {
    const fake = fakeRepo().on("GET", `${BASE}/commits/main`, () => new Response("c0ffee0000000000000000000000000000000001"));
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "create_branch", arguments: { owner: "octo", repo: "app", branch: "feature/dashboard" } });
    expect(resultJson(r)).toMatchObject({ created: "feature/dashboard", from: "main" });
    expect(fake.callsTo("POST", `${BASE}/git/refs`)[0].body).toEqual({ ref: "refs/heads/feature/dashboard", sha: "c0ffee0000000000000000000000000000000001" });
    await client.close();
  });

  it("delete_branch requires explicit confirmation and protects the default branch", async () => {
    const fake = fakeRepo()
      .on("GET", `${BASE}/git/ref/heads/old-branch`, () => ({ object: { sha: "dead000000000000000000000000000000000001" } }))
      .on("DELETE", `${BASE}/git/refs/heads/old-branch`, () => new Response(null, { status: 204 }));
    const client = await connectClient(testEnv(), fake);

    const noConfirm = await client.callTool({ name: "delete_branch", arguments: { owner: "octo", repo: "app", branch: "old-branch" } });
    expect(resultJson(noConfirm)).toMatchObject({ error: { type: "confirmation_required", expected_confirm_value: "old-branch" } });
    expect(fake.callsTo("DELETE", /refs/).length).toBe(0);

    const defaultBranch = await client.callTool({ name: "delete_branch", arguments: { owner: "octo", repo: "app", branch: "main", confirm: "main" } });
    expect(defaultBranch.isError).toBe(true);

    const ok = await client.callTool({ name: "delete_branch", arguments: { owner: "octo", repo: "app", branch: "old-branch", confirm: "old-branch" } });
    expect(resultJson(ok)).toMatchObject({ deleted: "old-branch", last_sha: "dead000000000000000000000000000000000001" });
    await client.close();
  });

  it("compares branches", async () => {
    const fake = new FakeGitHub().on("GET", "/repos/octo/app/compare/main...feature/dashboard", () => ({
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      commits: [{ sha: "s1", commit: { message: "one", author: { name: "a", date: "d" } } }],
      files: [{ filename: "a.ts", status: "added", additions: 3, deletions: 0, changes: 3, patch: "@@ +1,3 @@" }],
    }));
    const client = await connectClient(testEnv(), fake);
    const body = resultJson(await client.callTool({ name: "compare_branches_or_commits", arguments: { owner: "octo", repo: "app", base: "main", head: "feature/dashboard" } }));
    expect(body).toMatchObject({ status: "ahead", ahead_by: 2, files: [{ filename: "a.ts", patch: "@@ +1,3 @@" }] });
    await client.close();
  });

  it("creates and merges a pull request", async () => {
    const pr = {
      number: 7,
      title: "Dashboard",
      state: "open",
      head: { ref: "feature/dashboard", sha: "h1", repo: { full_name: "octo/app" } },
      base: { ref: "main", sha: "b1", repo: { full_name: "octo/app" } },
      html_url: "https://github.com/octo/app/pull/7",
    };
    const fake = new FakeGitHub()
      .on("POST", "/repos/octo/app/pulls", () => jsonResponse(pr, 201))
      .on("PUT", "/repos/octo/app/pulls/7/merge", () => ({ merged: true, sha: "m1", message: "Pull Request successfully merged" }))
      .on("GET", "/repos/octo/app/pulls/7", () => pr)
      .on("DELETE", "/repos/octo/app/git/refs/heads/feature/dashboard", () => new Response(null, { status: 204 }));
    const client = await connectClient(testEnv(), fake);
    const created = resultJson(await client.callTool({ name: "create_pull_request", arguments: { owner: "octo", repo: "app", title: "Dashboard", head: "feature/dashboard", base: "main" } }));
    expect(created).toMatchObject({ created: true, number: 7, head: { ref: "feature/dashboard" } });
    const merged = resultJson(await client.callTool({ name: "merge_pull_request", arguments: { owner: "octo", repo: "app", pull_number: 7, merge_method: "squash", delete_branch_after_merge: true } }));
    expect(merged).toMatchObject({ merged: true, merge_commit_sha: "m1", deleted_branch: "feature/dashboard" });
    expect(fake.callsTo("PUT", "/repos/octo/app/pulls/7/merge")[0].body).toMatchObject({ merge_method: "squash" });
    await client.close();
  });

  it("revert_commit refuses when a file changed after the commit", async () => {
    const fake = fakeRepo(
      new FakeGitHub()
      .on("GET", `${BASE}/commits/abc1234`, () => ({
        sha: "abc1234000000000000000000000000000000000",
        parents: [{ sha: "par00000000000000000000000000000000000001" }],
        commit: { message: "Change index" },
        files: [{ filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2 }],
      }))
      .on("GET", `${BASE}/git/trees/par00000000000000000000000000000000000001`, () => ({ sha: "p", truncated: false, tree: [{ path: "src/index.ts", mode: "100644", type: "blob", sha: "orig" }] }))
      .on("GET", `${BASE}/git/trees/abc1234000000000000000000000000000000000`, () => ({ sha: "t", truncated: false, tree: [{ path: "src/index.ts", mode: "100644", type: "blob", sha: "changed-in-target" }] }))
      .on("GET", `${BASE}/git/trees/c0ffee0000000000000000000000000000000001`, () => ({ sha: "h", truncated: false, tree: [{ path: "src/index.ts", mode: "100644", type: "blob", sha: "changed-again-later" }] })),
    );
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "revert_commit", arguments: { owner: "octo", repo: "app", commit_sha: "abc1234" } });
    expect(r.isError).toBe(true);
    expect(resultJson(r)).toMatchObject({ error: { status: 409, conflicting_files: ["src/index.ts"] } });
    expect(fake.callsTo("POST", /git\/commits/).length).toBe(0);
    await client.close();
  });

  it("revert_commit restores the parent version of modified files and removes added files", async () => {
    const fake = fakeRepo(
      new FakeGitHub()
        .on("GET", `${BASE}/commits/abc1234`, () => ({
          sha: "abc1234000000000000000000000000000000000",
          parents: [{ sha: "par00000000000000000000000000000000000001" }],
          commit: { message: "Change index\n\nbody" },
          files: [
            { filename: "src/index.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
            { filename: "added.txt", status: "added", additions: 1, deletions: 0, changes: 1 },
          ],
        }))
        .on("GET", `${BASE}/git/trees/par00000000000000000000000000000000000001`, () => ({ sha: "p", truncated: false, tree: [{ path: "src/index.ts", mode: "100755", type: "blob", sha: "orig" }] }))
        .on("GET", `${BASE}/git/trees/abc1234000000000000000000000000000000000`, () => ({
          sha: "t",
          truncated: false,
          tree: [
            { path: "src/index.ts", mode: "100755", type: "blob", sha: "new" },
            { path: "added.txt", mode: "100644", type: "blob", sha: "add" },
          ],
        }))
        .on("GET", `${BASE}/git/trees/c0ffee0000000000000000000000000000000001`, () => ({
          sha: "h",
          truncated: false,
          tree: [
            { path: "src/index.ts", mode: "100755", type: "blob", sha: "new" },
            { path: "added.txt", mode: "100644", type: "blob", sha: "add" },
          ],
        }))
        .on("GET", `${BASE}/git/trees/tree000000000000000000000000000000000001`, () => ({
          sha: "tree000000000000000000000000000000000001",
          truncated: false,
          tree: [
            { path: "src/index.ts", mode: "100755", type: "blob", sha: "new" },
            { path: "added.txt", mode: "100644", type: "blob", sha: "add" },
          ],
        })),
    );
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "revert_commit", arguments: { owner: "octo", repo: "app", commit_sha: "abc1234" } });
    expect(r.isError).toBeFalsy();
    const tree = fake.callsTo("POST", `${BASE}/git/trees`)[0].body as { tree: unknown[] };
    expect(tree.tree).toEqual([
      { path: "src/index.ts", mode: "100755", type: "blob", sha: "orig" },
      { path: "added.txt", mode: "100644", type: "blob", sha: null },
    ]);
    const commit = fake.callsTo("POST", `${BASE}/git/commits`)[0].body as { message: string };
    expect(commit.message).toBe('Revert "Change index"\n\nThis reverts commit abc1234000000000000000000000000000000000.');
    await client.close();
  });

  it("graphql_query blocks mutations unless explicitly allowed", async () => {
    const client = await connectClient(testEnv(), new FakeGitHub());
    const r = await client.callTool({ name: "graphql_query", arguments: { query: "mutation { addStar(input:{starrableId:\"x\"}) { clientMutationId } }" } });
    expect(r.isError).toBe(true);
    expect(resultJson(r)).toMatchObject({ error: { type: "invalid_input" } });
    await client.close();
  });

  it("input validation rejects bad arguments before calling GitHub", async () => {
    const fake = new FakeGitHub();
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "get_file_contents", arguments: { owner: "octo", repo: "../etc", path: "x" } });
    expect(r.isError).toBe(true);
    expect(fake.calls.length).toBe(0);
    await client.close();
  });

  it("never echoes the token even if GitHub's error message contains it", async () => {
    const fake = new FakeGitHub().on("GET", "/repos/octo/app", () => jsonResponse({ message: `weird error mentioning ${TEST_TOKEN}` }, 500));
    const client = await connectClient(testEnv(), fake);
    const r = await client.callTool({ name: "get_repository", arguments: { owner: "octo", repo: "app" } });
    expect(JSON.stringify(r)).not.toContain(TEST_TOKEN);
    await client.close();
  });
});
