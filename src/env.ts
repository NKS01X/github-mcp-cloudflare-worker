/**
 * Worker bindings.
 *
 * Secrets (set with `npx wrangler secret put <NAME>`, never committed):
 *   - GITHUB_TOKEN    GitHub Personal Access Token used for every GitHub API call.
 *   - MCP_ACCESS_KEY  Random key that protects the MCP endpoint itself. Created
 *                     automatically by `npm run deploy`.
 *
 * Plain variables live in wrangler.jsonc under "vars".
 */
export interface Env {
  GITHUB_TOKEN?: string;
  MCP_ACCESS_KEY?: string;
  GITHUB_TOOLSETS?: string;
  GITHUB_READ_ONLY?: string;
  GITHUB_API_URL?: string;
  ALLOW_UNAUTHENTICATED_MCP?: string;
}
