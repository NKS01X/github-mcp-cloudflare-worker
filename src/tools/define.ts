import { z } from "zod";
import type { ServerConfig, Toolset } from "../config";
import type { GitHubClient } from "../github/client";
import { ConfirmationRequiredError } from "../github/errors";

export interface ToolContext {
  gh: GitHubClient;
  config: ServerConfig;
}

/** A tool result whose main payload is plain text (file contents, diffs, logs). */
export class TextResult {
  constructor(
    readonly text: string,
    readonly structured: Record<string, unknown>,
  ) {}
}

export type ToolHandlerResult = unknown | TextResult;

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  toolset: Toolset;
  title: string;
  description: string;
  input: S;
  /** true = never modifies anything on GitHub. */
  readOnly: boolean;
  /** true = may delete or irreversibly change data. */
  destructive?: boolean;
  /** true = calling twice with the same args has no additional effect. */
  idempotent?: boolean;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolHandlerResult>;
}

/** Identity helper that keeps the handler's args strongly typed. */
export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

// ---------------------------------------------------------------------------
// Reusable schema fragments. Descriptions matter: Claude reads them.

export const owner = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-_.]*)$/, "Invalid GitHub owner name")
  .describe("Repository owner (user or organization login).");

export const repo = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "Invalid repository name")
  .describe("Repository name (without owner).");

export const repoArgs = { owner, repo };

export const ref = z
  .string()
  .min(1)
  .max(255)
  .describe("Branch name, tag name or commit SHA. Omit to use the repository's default branch.");

export const branch = z.string().min(1).max(255).describe("Branch name (e.g. 'main' or 'feature/dashboard').");

export const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.split("/").some((s) => s === ".." || s === "."), "Path must not contain '.' or '..' segments")
  .describe("Path of the file inside the repository, relative to the root, using '/' (e.g. 'src/utils/date.ts').");

export const sha = z.string().regex(/^[0-9a-fA-F]{4,64}$/, "Must be a hex commit/blob SHA").describe("Git object SHA.");

export const issueNumber = z.number().int().positive().describe("Issue or pull request number (the #N shown on GitHub).");

export const pagination = {
  per_page: z.number().int().min(1).max(100).default(30).describe("Results per page (max 100)."),
  page: z.number().int().min(1).default(1).describe("Page number (see pagination.next_page)."),
};

export const confirmField = (what: string) =>
  z
    .string()
    .optional()
    .describe(
      `Safety confirmation. Must be exactly ${what}. Only set this after the user has explicitly approved this irreversible action in the conversation.`,
    );

/** Throw unless `given` exactly equals `expected`. */
export function requireConfirmation(given: string | undefined, expected: string, action: string): void {
  if (given !== expected) throw new ConfirmationRequiredError(action, expected);
}
