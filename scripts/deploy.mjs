#!/usr/bin/env node
/**
 * npm run deploy        Deploy the Worker, make sure the MCP access key exists,
 *                       verify the live endpoint, and print the URL for Claude.
 * npm run endpoint      Print the saved MCP endpoint again (no deploy).
 * npm run rotate-key    Deploy and replace the MCP access key (old URL stops working).
 *
 * Only Node built-ins are used. Wrangler is run from node_modules.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = join(ROOT, ".mcp-connection.json");
const args = new Set(process.argv.slice(2));
const urlArg = process.argv.slice(2).find((a) => a.startsWith("--url="))?.slice(6);

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function wranglerBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("wrangler/package.json", { paths: [ROOT] });
  return join(dirname(pkgPath), JSON.parse(readFileSync(pkgPath, "utf8")).bin.wrangler);
}

/** Run wrangler; optionally stream its output to the terminal while capturing it. */
function wrangler(argv, { input, echo = true } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [wranglerBin(), ...argv], {
      cwd: ROOT,
      stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      if (echo) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (echo) process.stderr.write(d);
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  try {
    chmodSync(STATE_FILE, 0o600);
  } catch {
    /* not supported on all platforms */
  }
}

/** Pick the Worker URL out of `wrangler deploy` output. */
export function parseDeployUrl(output) {
  const urls = [...output.matchAll(/https:\/\/[^\s"'`<>()]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ""));
  const candidates = urls.filter((u) => {
    try {
      const host = new URL(u).hostname;
      return !/(^|\.)cloudflare\.com$/.test(host) && !/(^|\.)github\.com$/.test(host) && !host.endsWith("anthropic.com");
    } catch {
      return false;
    }
  });
  return candidates.find((u) => new URL(u).hostname.endsWith(".workers.dev")) ?? candidates[0];
}

function endpointFor(url, key) {
  return `${url.replace(/\/+$/, "")}/mcp/${key}`;
}

function printEndpoint(endpoint) {
  const line = "─".repeat(Math.min(100, endpoint.length + 4));
  console.log(`\n${c.green(c.bold("Your MCP endpoint (paste this into Claude → Settings → Connectors → Add custom connector):"))}`);
  console.log(c.cyan(line));
  console.log(`  ${c.bold(endpoint)}`);
  console.log(c.cyan(line));
  console.log(c.yellow("Keep this URL private: anyone who has it can use your GitHub token's permissions through this server."));
  console.log(`Show it again any time with ${c.bold("npm run endpoint")}.\n`);
}

async function rpc(endpoint, body, protocolVersion) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(protocolVersion && { "mcp-protocol-version": protocolVersion }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let message;
  try {
    message = JSON.parse(data ? data.slice(6) : text);
  } catch {
    message = undefined;
  }
  return { status: res.status, message, text };
}

async function verify(url, endpoint) {
  console.log(c.bold("\nVerifying the live endpoint…"));
  let health;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/`);
      if (res.ok) {
        health = await res.json();
        break;
      }
    } catch {
      /* DNS for a brand-new workers.dev subdomain can take a moment */
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!health) {
    console.log(c.yellow("  • Could not reach the Worker yet (a new workers.dev subdomain can take a few minutes). Try `npm run smoke` later."));
    return;
  }
  console.log(`  • Worker is up — ${health.tool_count} tools, read_only=${health.read_only}`);

  const init = await rpc(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "deploy-check", version: "1" } },
  });
  if (init.status !== 200 || !init.message?.result) {
    console.log(c.red(`  • MCP initialize failed (HTTP ${init.status}): ${init.text.slice(0, 300)}`));
    return;
  }
  console.log(`  • MCP initialize OK (protocol ${init.message.result.protocolVersion}, Streamable HTTP)`);

  const who = await rpc(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_authenticated_user", arguments: {} } }, "2025-06-18");
  const result = who.message?.result;
  const text = result?.content?.[0]?.text ?? "";
  if (result && !result.isError) {
    const body = JSON.parse(text);
    console.log(c.green(`  • GitHub token works — authenticated as ${body.user?.login} (${body.token?.kind})`));
  } else {
    console.log(c.red(`  • GitHub check failed: ${text.slice(0, 400)}`));
  }
}

async function main() {
  const state = readState();

  if (args.has("--show")) {
    if (urlArg) {
      state.url = urlArg;
      writeState(state);
    }
    if (!state.url || !state.key) {
      console.log(c.yellow("No saved endpoint yet. Run `npm run deploy` first."));
      process.exit(1);
    }
    printEndpoint(endpointFor(state.url, state.key));
    return;
  }

  // 1. Logged in?
  const who = await wrangler(["whoami"], { echo: false });
  if (/not authenticated|You are not logged in/i.test(who.stdout + who.stderr)) {
    console.error(c.red("You are not logged in to Cloudflare. Run: npx wrangler login"));
    process.exit(1);
  }

  // 2. Deploy.
  console.log(c.bold("Deploying to Cloudflare Workers…\n"));
  const deploy = await wrangler(["deploy"]);
  if (deploy.code !== 0) {
    console.error(c.red("\nDeployment failed (see the Wrangler output above)."));
    process.exit(deploy.code);
  }
  const url = urlArg ?? parseDeployUrl(deploy.stdout + deploy.stderr) ?? state.url;
  if (!url) {
    console.log(
      c.yellow(
        "\nDeployed, but the Worker URL was not found in Wrangler's output. Find it in the Cloudflare dashboard (Workers & Pages → github-mcp-server), then run:\n  npm run endpoint -- --url=https://<your-worker-url>",
      ),
    );
  }

  // 3. Secrets.
  const list = await wrangler(["secret", "list", "--format", "json"], { echo: false });
  const names = new Set();
  try {
    for (const s of JSON.parse(list.stdout.slice(list.stdout.indexOf("[")))) names.add(s.name);
  } catch {
    for (const m of (list.stdout + list.stderr).matchAll(/"name"\s*:\s*"([A-Z0-9_]+)"/g)) names.add(m[1]);
  }

  if (!names.has("GITHUB_TOKEN")) {
    console.log(c.yellow(`\n${c.bold("GITHUB_TOKEN is not set yet.")} Add it now (takes effect immediately, no redeploy needed):\n  npx wrangler secret put GITHUB_TOKEN`));
  }

  let key = state.key;
  const rotate = args.has("--rotate-key");
  if (rotate || !names.has("MCP_ACCESS_KEY")) {
    key = randomBytes(32).toString("base64url");
    console.log(c.bold(`\n${rotate ? "Rotating" : "Creating"} the MCP access key (protects your endpoint)…`));
    const put = await wrangler(["secret", "put", "MCP_ACCESS_KEY"], { input: key, echo: false });
    if (put.code !== 0) {
      console.error(c.red(`Failed to set MCP_ACCESS_KEY:\n${put.stderr || put.stdout}`));
      process.exit(1);
    }
    console.log(c.green("  • MCP_ACCESS_KEY stored as a Worker secret."));
    if (rotate) console.log(c.yellow("  • The previous endpoint URL no longer works. Update the connector URL in Claude."));
  } else if (!key) {
    console.log(
      c.yellow(
        "\nMCP_ACCESS_KEY exists on Cloudflare but this computer has no saved copy (secrets cannot be read back).\nIf you still have the URL from before, keep using it. Otherwise run `npm run rotate-key` to create a new one.",
      ),
    );
  }

  const next = { ...state, ...(url && { url }), ...(key && { key }), worker: "github-mcp-server", updated_at: new Date().toISOString() };
  writeState(next);

  if (next.url && next.key) {
    const endpoint = endpointFor(next.url, next.key);
    await verify(next.url, endpoint).catch((e) => console.log(c.yellow(`  • Verification skipped: ${e.message}`)));
    printEndpoint(endpoint);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(c.red(err?.stack ?? String(err)));
    process.exit(1);
  });
}
