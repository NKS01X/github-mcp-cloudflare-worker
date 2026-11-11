import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github/client";
import { GitHubApiError, GitHubRateLimitError, MissingTokenError } from "../src/github/errors";
import { FakeGitHub, TEST_TOKEN, jsonResponse } from "./helpers";

function client(fake: FakeGitHub, opts: Partial<ConstructorParameters<typeof GitHubClient>[0]> = {}) {
  const sleeps: number[] = [];
  const gh = new GitHubClient({
    token: TEST_TOKEN,
    apiUrl: "https://api.github.com",
    graphqlUrl: "https://api.github.com/graphql",
    fetchImpl: fake.fetch as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
    ...opts,
  });
  return { gh, sleeps };
}

describe("GitHubClient", () => {
  it("sends auth, API version and user agent headers", async () => {
    const fake = new FakeGitHub().on("GET", "/user", () => ({ login: "me" }));
    const { gh } = client(fake);
    expect(await gh.get("/user")).toEqual({ login: "me" });
    const h = fake.calls[0].headers;
    expect(h.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(h.get("x-github-api-version")).toBe("2026-03-10");
    expect(h.get("user-agent")).toMatch(/^github-mcp-server\//);
  });

  it("fails clearly when no token is configured", async () => {
    const { gh } = client(new FakeGitHub(), { token: undefined });
    await expect(gh.get("/user")).rejects.toBeInstanceOf(MissingTokenError);
  });

  it("retries transient 5xx errors on GET", async () => {
    const fake = new FakeGitHub()
      .on("GET", "/repos/a/b", () => jsonResponse({ message: "Bad gateway" }, 502), 2)
      .on("GET", "/repos/a/b", () => ({ full_name: "a/b" }));
    const { gh, sleeps } = client(fake);
    expect(await gh.get("/repos/a/b")).toEqual({ full_name: "a/b" });
    expect(fake.calls.length).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  it("does not retry non-idempotent POST on 5xx", async () => {
    const fake = new FakeGitHub().on("POST", "/repos/a/b/issues", () => jsonResponse({ message: "oops" }, 502));
    const { gh } = client(fake);
    await expect(gh.post("/repos/a/b/issues", { title: "x" })).rejects.toBeInstanceOf(GitHubApiError);
    expect(fake.calls.length).toBe(1);
  });

  it("retries network errors on GET", async () => {
    let n = 0;
    const fake = new FakeGitHub().on("GET", "/user", () => {
      if (n++ === 0) throw new TypeError("connection reset");
      return { login: "me" };
    });
    const { gh } = client(fake);
    expect(await gh.get("/user")).toEqual({ login: "me" });
  });

  it("waits and retries a short Retry-After secondary rate limit", async () => {
    const fake = new FakeGitHub()
      .on("POST", "/repos/a/b/issues", () => jsonResponse({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "2" }), 1)
      .on("POST", "/repos/a/b/issues", () => ({ number: 1 }));
    const { gh, sleeps } = client(fake);
    expect(await gh.post("/repos/a/b/issues", { title: "x" })).toEqual({ number: 1 });
    expect(sleeps).toEqual([2000]);
  });

  it("reports a primary rate limit with its reset time instead of waiting long", async () => {
    const reset = Math.floor(1_700_000_000_000 / 1000) + 1800;
    const fake = new FakeGitHub().on("GET", "/user", () =>
      jsonResponse({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
    );
    const { gh, sleeps } = client(fake);
    const err = (await gh.get("/user").catch((e) => e)) as GitHubRateLimitError;
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect(err.details.rate_limit_reset).toBe(new Date(reset * 1000).toISOString());
    expect(sleeps).toEqual([]);
  });

  it("maps 401 to an actionable hint and never leaks the token", async () => {
    const fake = new FakeGitHub().on("GET", "/user", () => jsonResponse({ message: `Bad credentials for ${TEST_TOKEN}` }, 401));
    const { gh } = client(fake);
    const err = (await gh.get("/user").catch((e) => e)) as GitHubApiError;
    expect(err.status).toBe(401);
    expect(err.hint).toMatch(/wrangler secret put GITHUB_TOKEN/);
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(TEST_TOKEN);
  });

  it("surfaces fine-grained permission requirements on 403", async () => {
    const fake = new FakeGitHub().on("PUT", "/repos/a/b/contents/x.txt", () =>
      jsonResponse({ message: "Resource not accessible by personal access token" }, 403, { "x-accepted-github-permissions": "contents=write" }),
    );
    const { gh } = client(fake);
    const err = (await gh.put("/repos/a/b/contents/x.txt", {}).catch((e) => e)) as GitHubApiError;
    expect(err.status).toBe(403);
    expect(err.details.accepted_permissions).toBe("contents=write");
  });

  it("reports pagination from Link headers", async () => {
    const fake = new FakeGitHub().on("GET", "/user/repos", () =>
      jsonResponse([{ id: 1 }], 200, { link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"' }),
    );
    const { gh } = client(fake);
    const page = await gh.getPage("/user/repos", { per_page: 1 });
    expect(page.pagination).toEqual({ page: 1, per_page: 1, has_next_page: true, next_page: 2, last_page: 5 });
  });

  it("raises GraphQL errors as API errors", async () => {
    const fake = new FakeGitHub().on("POST", "/graphql", () => ({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }));
    const { gh } = client(fake);
    const err = (await gh.graphql("query { x }").catch((e) => e)) as GitHubApiError;
    expect(err.status).toBe(404);
  });

  it("downloads redirected logs without sending the GitHub token", async () => {
    const fake = new FakeGitHub()
      .on("GET", "/repos/a/b/actions/jobs/7/logs", () => new Response(null, { status: 302, headers: { location: "https://logs.example.net/signed?sig=1" } }))
      .on("GET", "/signed", () => new Response("line1\nERROR boom\n", { status: 200 }));
    const { gh } = client(fake);
    const res = await gh.request("GET", "/repos/a/b/actions/jobs/7/logs", { redirect: "manual" });
    const text = await gh.fetchRedirectTarget(res.headers.get("location")!);
    expect(text).toContain("ERROR boom");
    const logCall = fake.calls.find((c) => c.url.hostname === "logs.example.net")!;
    expect(logCall.headers.get("authorization")).toBeNull();
  });
});
