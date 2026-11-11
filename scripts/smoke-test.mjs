#!/usr/bin/env node
/**
 * Live end-to-end check of a deployed (or local) server, speaking MCP over HTTP.
 *
 *   npm run smoke                                   # uses the endpoint saved by `npm run deploy`
 *   npm run smoke -- --endpoint=http://localhost:8787/mcp/<key>
 *   npm run smoke -- --repo=yourname/scratch-repo   # ALSO runs a write test in that repo:
 *        creates a temporary branch, commits two files, compares with the default branch,
 *        opens a draft pull request, closes it, and deletes the branch again.
 *
 * Use a throwaway repository for --repo. Nothing outside the temporary branch/PR is touched.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opt = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

let endpoint = opt("endpoint");
if (!endpoint) {
  try {
    const s = JSON.parse(readFileSync(join(ROOT, ".mcp-connection.json"), "utf8"));
    endpoint = `${s.url.replace(/\/+$/, "")}/mcp/${s.key}`;
  } catch {
    console.error("No endpoint. Run `npm run deploy` first or pass --endpoint=<url>.");
    process.exit(1);
  }
}
const repoArg = opt("repo");

let id = 0;
let failures = 0;
async function rpc(method, params) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params && { params }) }),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, message: JSON.parse(data ? data.slice(6) : text) };
}

async function tool(name, args) {
  const { message } = await rpc("tools/call", { name, arguments: args });
  if (message.error) throw new Error(`${name}: ${message.error.message}`);
  const text = message.result.content[0].text;
  if (message.result.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function step(label, fn) {
  try {
    const detail = await fn();
    console.log(`  \x1b[32m✔\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✘\x1b[0m ${label} — ${err.message.slice(0, 500)}`);
    return false;
  }
}

const masked = endpoint.replace(/\/mcp\/.+$/, "/mcp/<key>");
console.log(`Smoke-testing ${masked}\n`);

await step("rejects a wrong access key", async () => {
  const res = await fetch(endpoint.replace(/\/mcp\/.+$/, "/mcp/wrong-key-for-smoke-test"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
  });
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  return "401";
});
await step("MCP initialize", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  if (!r.message.result) throw new Error(JSON.stringify(r.message));
  return `protocol ${r.message.result.protocolVersion}, server ${r.message.result.serverInfo.name} ${r.message.result.serverInfo.version}`;
});
await step("tools/list", async () => {
  const r = await rpc("tools/list");
  return `${r.message.result.tools.length} tools`;
});
let login;
await step("GitHub authentication (get_authenticated_user)", async () => {
  const r = await tool("get_authenticated_user", {});
  login = r.user.login;
  return `${login}, ${r.token.kind}`;
});
await step("rate limit (get_rate_limit)", async () => {
  const r = await tool("get_rate_limit", {});
  return `core ${r.core.remaining}/${r.core.limit}`;
});
await step("list_repositories", async () => {
  const r = await tool("list_repositories", { per_page: 5 });
  return `${r.repositories.length} shown, e.g. ${r.repositories.map((x) => x.full_name).slice(0, 3).join(", ")}`;
});

if (repoArg) {
  const [owner, repo] = repoArg.split("/");
  const branch = `mcp-smoke-${Date.now()}`;
  console.log(`\nWrite test in ${owner}/${repo} on temporary branch ${branch}`);
  let base;
  let prNumber;
  let branchCreated = false;
  await step("get_repository", async () => {
    const r = await tool("get_repository", { owner, repo });
    base = r.default_branch;
    return `default branch ${base}, private=${r.private}`;
  });
  await step("create_branch", async () => {
    await tool("create_branch", { owner, repo, branch, from: base });
    branchCreated = true;
    return branch;
  });
  await step("commit_files (commit + push two files)", async () => {
    const r = await tool("commit_files", {
      owner,
      repo,
      branch,
      message: "MCP smoke test commit",
      files: [
        { path: `mcp-smoke/${branch}.md`, content: `# Smoke test\n\nCreated ${new Date().toISOString()}\n` },
        { path: `mcp-smoke/${branch}.txt`, content: "hello from the GitHub MCP server\n" },
      ],
    });
    return r.commit_sha.slice(0, 7);
  });
  await step("create_or_update_file (update one file)", async () => {
    const r = await tool("create_or_update_file", { owner, repo, branch, path: `mcp-smoke/${branch}.txt`, content: "updated\n", message: "MCP smoke test update" });
    return `${r.action} ${r.commit_sha.slice(0, 7)}`;
  });
  await step("get_file_contents (read it back)", async () => {
    const r = await tool("get_file_contents", { owner, repo, path: `mcp-smoke/${branch}.txt`, ref: branch });
    if (!String(r).endsWith("updated\n")) throw new Error("content mismatch");
    return "content matches";
  });
  await step("compare_branches_or_commits", async () => {
    const r = await tool("compare_branches_or_commits", { owner, repo, base, head: branch, diff_format: "summary" });
    return `${r.status}, ahead by ${r.ahead_by}, ${r.files_changed} files`;
  });
  await step("create_pull_request (draft)", async () => {
    const r = await tool("create_pull_request", { owner, repo, title: "MCP smoke test (will be closed)", head: branch, base, draft: true, body: "Automated smoke test." });
    prNumber = r.number;
    return `#${prNumber}`;
  });
  if (prNumber) {
    await step("update_pull_request (close)", async () => {
      const r = await tool("update_pull_request", { owner, repo, pull_number: prNumber, state: "closed" });
      return r.state;
    });
  }
  if (branchCreated) {
    await step("delete_branch (with confirmation)", async () => {
      await tool("delete_branch", { owner, repo, branch, confirm: branch });
      return "cleaned up";
    });
  }
}

console.log(failures === 0 ? "\n\x1b[32mAll checks passed.\x1b[0m" : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
