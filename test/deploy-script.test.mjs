import { describe, expect, it } from "vitest";
import { parseDeployUrl } from "../scripts/deploy.mjs";

describe("deploy script", () => {
  it("extracts the workers.dev URL from wrangler deploy output", () => {
    const out = `
 ⛅️ wrangler 4.151.1
───────────────────
Total Upload: 812.40 KiB / gzip: 140.12 KiB
Your Worker has access to the following bindings:
Binding                                         Resource
env.GITHUB_TOOLSETS ("all")                     Environment Variable

Uploaded github-mcp-server (4.12 sec)
Deployed github-mcp-server triggers (1.02 sec)
  https://github-mcp-server.jane-doe.workers.dev
Current Version ID: 0b6b8c4e-1111-2222-3333-444455556666
`;
    expect(parseDeployUrl(out)).toBe("https://github-mcp-server.jane-doe.workers.dev");
  });

  it("ignores dashboard/docs links and falls back to a custom domain", () => {
    const out = "See https://developers.cloudflare.com/workers/ for docs\nDeployed github-mcp-server triggers\n  https://mcp.example.com (custom domain)\n";
    expect(parseDeployUrl(out)).toBe("https://mcp.example.com");
  });

  it("returns undefined when there is no URL", () => {
    expect(parseDeployUrl("Uploaded github-mcp-server\nNo routes\n")).toBeUndefined();
  });
});
