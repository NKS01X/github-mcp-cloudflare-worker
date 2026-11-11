import type { ServerConfig } from "../config";
import { actionsTools } from "./actions";
import { branchTools } from "./branches";
import { contextTools } from "./context";
import type { ToolDefinition } from "./define";
import { discussionTools } from "./discussions";
import { gistTools, notificationTools, orgTools, webhookTools } from "./extras";
import { fileTools } from "./files";
import { gitTools } from "./git";
import { issueTools } from "./issues";
import { pullTools } from "./pulls";
import { releaseTools } from "./releases";
import { repoTools } from "./repos";
import { searchTools } from "./search";

/** Every tool this server implements, in display order. */
export const ALL_TOOLS: ToolDefinition[] = [
  ...contextTools,
  ...repoTools,
  ...fileTools,
  ...gitTools,
  ...branchTools,
  ...pullTools,
  ...issueTools,
  ...discussionTools,
  ...searchTools,
  ...actionsTools,
  ...releaseTools,
  ...webhookTools,
  ...gistTools,
  ...notificationTools,
  ...orgTools,
] as unknown as ToolDefinition[];

/** Tools exposed under the current configuration (toolsets + read-only mode). */
export function enabledTools(config: ServerConfig): ToolDefinition[] {
  return ALL_TOOLS.filter((t) => config.toolsets.has(t.toolset) && (!config.readOnly || t.readOnly));
}
