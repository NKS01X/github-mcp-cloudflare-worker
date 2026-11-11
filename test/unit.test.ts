import { describe, expect, it } from "vitest";
import { checkAccess, safeEqual } from "../src/auth";
import { loadConfig } from "../src/config";
import { encPath, parseLinkHeader, redactSecrets } from "../src/github/client";
import { compact, summarizeRepo, truncate } from "../src/github/compact";
import { base64ToBytes, decodeIfText, isValidBase64, utf8ToBase64 } from "../src/github/encoding";
import { globToRegExp, normalizePath } from "../src/github/gitops";
import { parseMcpPath } from "../src/index";
import { ALL_TOOLS, enabledTools } from "../src/tools/index";
import { TEST_TOKEN } from "./helpers";

describe("encoding", () => {
  it("round-trips UTF-8 (incl. emoji and CJK) through base64", () => {
    const text = "héllo wörld — 日本語 🚀\nline2";
    const b64 = utf8ToBase64(text);
    expect(isValidBase64(b64)).toBe(true);
    const d = decodeIfText(base64ToBytes(b64));
    expect(d).toEqual({ isText: true, text });
  });

  it("detects binary content", () => {
    expect(decodeIfText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])).isText).toBe(false);
    expect(decodeIfText(new Uint8Array([0xff, 0xfe, 0xfd])).isText).toBe(false);
  });

  it("validates base64", () => {
    expect(isValidBase64("aGVsbG8=")).toBe(true);
    expect(isValidBase64("not base64!")).toBe(false);
  });
});

describe("paths and globs", () => {
  it("encodes path segments but keeps slashes", () => {
    expect(encPath("/src/my file#1.ts")).toBe("src/my%20file%231.ts");
    expect(encPath("feature/dashboard")).toBe("feature/dashboard");
  });

  it("normalizes paths", () => {
    expect(normalizePath("/a//b/c/")).toBe("a/b/c");
    expect(normalizePath("a\\b")).toBe("a/b");
  });

  it("matches globs and substrings", () => {
    expect(globToRegExp("*.ts").test("src/utils/date.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/utils/date.tsx")).toBe(false);
    expect(globToRegExp("src/**/*.test.ts").test("src/a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("src/**/*.test.ts").test("lib/a.test.ts")).toBe(false);
    expect(globToRegExp("README*").test("docs/README.md")).toBe(true);
    expect(globToRegExp("config").test("app/Config/settings.json")).toBe(true);
  });
});

describe("pagination and redaction", () => {
  it("parses GitHub Link headers", () => {
    const link =
      '<https://api.github.com/user/repos?page=3&per_page=30>; rel="next", <https://api.github.com/user/repos?page=9&per_page=30>; rel="last"';
    expect(parseLinkHeader(link)).toEqual({ next: 3, last: 9 });
    expect(parseLinkHeader(null)).toEqual({});
  });

  it("redacts the configured token and token-shaped strings", () => {
    const text = `token ${TEST_TOKEN} and ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Authorization: Bearer xyz123`;
    const out = redactSecrets(text, [TEST_TOKEN]);
    expect(out).not.toContain(TEST_TOKEN);
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("xyz123");
  });
});

describe("compaction", () => {
  it("drops *_url noise and collapses users to logins", () => {
    const c = compact({
      id: 1,
      node_id: "X",
      html_url: "https://github.com/a/b",
      url: "https://api.github.com/repos/a/b",
      events_url: "…",
      owner: { login: "octocat", type: "User", avatar_url: "x", html_url: "y" },
    }) as Record<string, unknown>;
    expect(c).toEqual({ id: 1, html_url: "https://github.com/a/b", owner: "octocat" });
  });

  it("summarizes repositories", () => {
    expect(summarizeRepo({ full_name: "a/b", private: true, pushed_at: "2026-01-01T00:00:00Z", hooks_url: "x", owner: {} })).toEqual({
      full_name: "a/b",
      private: true,
      pushed_at: "2026-01-01T00:00:00Z",
    });
  });

  it("truncates with a marker", () => {
    expect(truncate("abcdef", 3)).toEqual({ text: "abc\n… [truncated 3 characters]", truncated: true });
    expect(truncate("abc", 3).truncated).toBe(false);
  });
});

describe("MCP endpoint authentication", () => {
  const req = (headers: Record<string, string> = {}) => new Request("https://x.workers.dev/mcp", { headers });

  it("compares in constant time and correctly", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
  });

  it("accepts the key in the path or as a bearer token", async () => {
    const key = "k".repeat(32);
    expect(await checkAccess({ pathKey: key, request: req(), expectedKey: key, allowUnauthenticated: false })).toMatchObject({ ok: true, via: "path" });
    expect(await checkAccess({ pathKey: undefined, request: req({ authorization: `Bearer ${key}` }), expectedKey: key, allowUnauthenticated: false })).toMatchObject({
      ok: true,
      via: "header",
    });
  });

  it("rejects wrong keys and fails closed when no key is configured", async () => {
    const key = "k".repeat(32);
    expect(await checkAccess({ pathKey: "wrong", request: req(), expectedKey: key, allowUnauthenticated: false })).toMatchObject({ ok: false, status: 401 });
    expect(await checkAccess({ pathKey: "anything", request: req(), expectedKey: undefined, allowUnauthenticated: false })).toMatchObject({ ok: false, status: 503 });
    expect(await checkAccess({ pathKey: "short", request: req(), expectedKey: "short", allowUnauthenticated: false })).toMatchObject({ ok: false, status: 503 });
    expect(await checkAccess({ pathKey: undefined, request: req(), expectedKey: undefined, allowUnauthenticated: true })).toMatchObject({ ok: true });
  });

  it("parses the MCP path", () => {
    expect(parseMcpPath("/mcp")).toEqual({ key: undefined });
    expect(parseMcpPath("/mcp/abc")).toEqual({ key: "abc" });
    expect(parseMcpPath("/mcp/abc/")).toEqual({ key: "abc" });
    expect(parseMcpPath("/mcp/a/b")).toBeNull();
    expect(parseMcpPath("/other")).toBeNull();
  });
});

describe("tool catalogue", () => {
  it("has unique, well-formed tool names with descriptions", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.title.length).toBeGreaterThan(3);
    }
  });

  it("requires a confirm argument on every irreversible delete/transfer tool", () => {
    const mustConfirm = ["delete_repository", "transfer_repository", "delete_branch", "delete_ref", "delete_release", "delete_gist", "delete_repository_webhook", "remove_collaborator"];
    for (const name of mustConfirm) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool!.input.shape), name).toContain("confirm");
      expect(tool!.destructive, name).toBe(true);
    }
  });

  it("filters by toolset and read-only mode", () => {
    const all = enabledTools(loadConfig({}));
    expect(all.length).toBe(ALL_TOOLS.length);
    const ro = enabledTools(loadConfig({ GITHUB_READ_ONLY: "true" }));
    expect(ro.length).toBeGreaterThan(40);
    expect(ro.every((t) => t.readOnly)).toBe(true);
    const some = enabledTools(loadConfig({ GITHUB_TOOLSETS: "files, pulls, bogus" }));
    expect(new Set(some.map((t) => t.toolset))).toEqual(new Set(["context", "files", "pulls"]));
    expect(loadConfig({ GITHUB_TOOLSETS: "files,bogus" }).unknownToolsets).toEqual(["bogus"]);
  });

  it("derives the GraphQL URL for GitHub Enterprise Server", () => {
    expect(loadConfig({ GITHUB_API_URL: "https://ghe.example.com/api/v3" }).graphqlUrl).toBe("https://ghe.example.com/api/graphql");
    expect(loadConfig({}).graphqlUrl).toBe("https://api.github.com/graphql");
  });
});
