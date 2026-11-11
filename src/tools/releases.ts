import { z } from "zod";
import { compact, pick } from "../github/compact";
import { enc, encPath } from "../github/client";
import { base64ToBytes, isValidBase64 } from "../github/encoding";
import { ToolInputError } from "../github/errors";
import { getDefaultBranch, resolveCommitSha } from "../github/gitops";
import { confirmField, defineTool, pagination, repoArgs, requireConfirmation } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;
const releaseId = z.number().int().positive().describe("Release ID (from list_releases or get_release).");

function releaseSummary(r: Record<string, unknown>, withBody = false) {
  const s = compact(pick(r, ["id", "tag_name", "name", "draft", "prerelease", "target_commitish", "author", "created_at", "published_at", "html_url"])) as Record<string, unknown>;
  if (withBody) s.body = r.body ?? "";
  if (Array.isArray(r.assets)) s.assets = (r.assets as Array<Record<string, unknown>>).map((a) => pick(a, ["id", "name", "size", "content_type", "download_count", "browser_download_url"]));
  if (r.upload_url && withBody) s.upload_url = r.upload_url;
  return s;
}

export const releaseTools = [
  defineTool({
    name: "list_releases",
    toolset: "releases",
    title: "List releases",
    description: "List releases (including drafts if you have push access), newest first.",
    input: z.object({ ...repoArgs, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/releases`, { per_page: a.per_page, page: a.page });
      return { releases: items.map((r) => releaseSummary(r)), pagination: p };
    },
  }),

  defineTool({
    name: "get_release",
    toolset: "releases",
    title: "Get a release",
    description: "Get a release with its notes and assets — by release_id, by tag, or the latest published release (omit both).",
    input: z.object({ ...repoArgs, release_id: releaseId.optional(), tag: z.string().optional() }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const base = `${repoPath(a.owner, a.repo)}/releases`;
      const path = a.release_id ? `${base}/${a.release_id}` : a.tag ? `${base}/tags/${encPath(a.tag)}` : `${base}/latest`;
      return releaseSummary(await gh.get(path), true);
    },
  }),

  defineTool({
    name: "create_release",
    toolset: "releases",
    title: "Create a release",
    description:
      "Create a release for a tag. If the tag does not exist it is created from target_commitish (default: default branch). Use draft: true to prepare it without publishing, then publish_release. generate_release_notes: true lets GitHub write notes from merged PRs.",
    input: z.object({
      ...repoArgs,
      tag_name: z.string().min(1).describe("e.g. 'v1.2.0'."),
      name: z.string().optional().describe("Release title. Default: the tag name."),
      body: z.string().max(125_000).optional().describe("Release notes (Markdown)."),
      target_commitish: z.string().optional().describe("Branch or SHA to tag if the tag is new."),
      draft: z.boolean().default(false),
      prerelease: z.boolean().default(false),
      generate_release_notes: z.boolean().default(false),
      make_latest: z.enum(["true", "false", "legacy"]).optional(),
    }),
    readOnly: false,
    handler: async ({ owner, repo, ...body }, { gh }) => ({ created: true, ...releaseSummary(await gh.post(`${repoPath(owner, repo)}/releases`, body), true) }),
  }),

  defineTool({
    name: "update_release",
    toolset: "releases",
    title: "Update a release",
    description: "Edit a release's tag, title, notes, draft/prerelease flags. Setting draft: false publishes it.",
    input: z.object({
      ...repoArgs,
      release_id: releaseId,
      tag_name: z.string().optional(),
      name: z.string().optional(),
      body: z.string().max(125_000).optional(),
      target_commitish: z.string().optional(),
      draft: z.boolean().optional(),
      prerelease: z.boolean().optional(),
      make_latest: z.enum(["true", "false", "legacy"]).optional(),
    }),
    readOnly: false,
    idempotent: true,
    handler: async ({ owner, repo, release_id, ...body }, { gh }) => {
      if (Object.values(body).every((v) => v === undefined)) throw new ToolInputError("Pass at least one field to change.");
      return releaseSummary(await gh.patch(`${repoPath(owner, repo)}/releases/${release_id}`, body), true);
    },
  }),

  defineTool({
    name: "publish_release",
    toolset: "releases",
    title: "Publish a draft release",
    description: "Publish a draft release (makes it public and notifies watchers).",
    input: z.object({ ...repoArgs, release_id: releaseId, make_latest: z.enum(["true", "false", "legacy"]).optional() }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => releaseSummary(await gh.patch(`${repoPath(a.owner, a.repo)}/releases/${a.release_id}`, { draft: false, make_latest: a.make_latest })),
  }),

  defineTool({
    name: "delete_release",
    toolset: "releases",
    title: "Delete a release",
    description: "Delete a release and its uploaded assets (the git tag is kept unless delete_tag is true). Requires confirm = the release's tag name after explicit user approval.",
    input: z.object({ ...repoArgs, release_id: releaseId, delete_tag: z.boolean().default(false), confirm: confirmField("the release's tag name") }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      const r = await gh.get<{ tag_name: string }>(`${repoPath(a.owner, a.repo)}/releases/${a.release_id}`);
      requireConfirmation(a.confirm, r.tag_name, `delete release ${r.tag_name}${a.delete_tag ? " and its tag" : ""}`);
      await gh.delete(`${repoPath(a.owner, a.repo)}/releases/${a.release_id}`);
      if (a.delete_tag) await gh.delete(`${repoPath(a.owner, a.repo)}/git/refs/tags/${encPath(r.tag_name)}`);
      return { deleted_release: a.release_id, tag: r.tag_name, tag_deleted: a.delete_tag };
    },
  }),

  defineTool({
    name: "list_release_assets",
    toolset: "releases",
    title: "List release assets",
    description: "List the files (assets) attached to a release, with download URLs.",
    input: z.object({ ...repoArgs, release_id: releaseId, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/releases/${a.release_id}/assets`, { per_page: a.per_page, page: a.page });
      return { assets: items.map((x) => pick(x, ["id", "name", "label", "size", "content_type", "download_count", "browser_download_url"])), pagination: p };
    },
  }),

  defineTool({
    name: "upload_release_asset",
    toolset: "releases",
    title: "Upload a release asset",
    description: "Attach a file to a release. Provide text content directly, or binary content as base64. Size limited by the MCP request size (keep it under a few MB).",
    input: z.object({
      ...repoArgs,
      release_id: releaseId,
      name: z.string().min(1).max(255).describe("File name, e.g. 'checksums.txt'."),
      content: z.string().max(15_000_000),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      content_type: z.string().default("application/octet-stream"),
      label: z.string().optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      if (a.encoding === "base64" && !isValidBase64(a.content)) throw new ToolInputError("content is not valid base64.");
      const release = await gh.get<{ upload_url: string }>(`${repoPath(a.owner, a.repo)}/releases/${a.release_id}`);
      const uploadBase = release.upload_url.replace(/\{.*\}$/, "");
      const url = new URL(uploadBase);
      url.searchParams.set("name", a.name);
      if (a.label) url.searchParams.set("label", a.label);
      const bytes = a.encoding === "base64" ? base64ToBytes(a.content) : new TextEncoder().encode(a.content);
      const asset = await gh.request<Record<string, unknown>>("POST", "", {
        absoluteUrl: url.toString(),
        rawBody: bytes,
        headers: { "Content-Type": a.content_type },
      });
      return pick(asset.data, ["id", "name", "size", "content_type", "browser_download_url"]);
    },
  }),

  defineTool({
    name: "delete_release_asset",
    toolset: "releases",
    title: "Delete a release asset",
    description: "Delete a file attached to a release. Requires confirm = the asset's file name after explicit user approval.",
    input: z.object({ ...repoArgs, asset_id: z.number().int().positive(), confirm: confirmField("the asset's file name") }),
    readOnly: false,
    destructive: true,
    handler: async (a, { gh }) => {
      const asset = await gh.get<{ name: string }>(`${repoPath(a.owner, a.repo)}/releases/assets/${a.asset_id}`);
      requireConfirmation(a.confirm, asset.name, `delete release asset ${asset.name}`);
      await gh.delete(`${repoPath(a.owner, a.repo)}/releases/assets/${a.asset_id}`);
      return { deleted_asset: asset.name };
    },
  }),

  // ---- Tags ------------------------------------------------------------------------

  defineTool({
    name: "list_tags",
    toolset: "releases",
    title: "List tags",
    description: "List the repository's git tags with the commit each points to.",
    input: z.object({ ...repoArgs, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<{ name: string; commit: { sha: string } }>(`${repoPath(a.owner, a.repo)}/tags`, { per_page: a.per_page, page: a.page });
      return { tags: items.map((t) => ({ name: t.name, commit_sha: t.commit.sha })), pagination: p };
    },
  }),

  defineTool({
    name: "get_tag",
    toolset: "releases",
    title: "Inspect a tag",
    description: "Inspect a tag reference: whether it is lightweight or annotated, the tagger and message (annotated), and the commit it points to.",
    input: z.object({ ...repoArgs, tag: z.string().min(1).describe("Tag name, e.g. 'v1.0.0'.") }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const r = await gh.get<{ ref: string; object: { sha: string; type: string } }>(`${repoPath(a.owner, a.repo)}/git/ref/tags/${encPath(a.tag)}`);
      if (r.object.type !== "tag") return { tag: a.tag, kind: "lightweight", commit_sha: r.object.sha };
      const t = await gh.get<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/git/tags/${r.object.sha}`);
      return {
        tag: a.tag,
        kind: "annotated",
        tag_object_sha: r.object.sha,
        message: t.message,
        tagger: t.tagger,
        target: t.object,
        verified: (t.verification as Record<string, unknown> | undefined)?.verified,
      };
    },
  }),

  defineTool({
    name: "create_tag",
    toolset: "releases",
    title: "Create a tag",
    description: "Create a git tag on a commit/branch (default: default branch head). Lightweight by default; pass a message to create an annotated tag.",
    input: z.object({
      ...repoArgs,
      tag: z.string().min(1).max(255).describe("e.g. 'v1.2.0'."),
      target: z.string().optional().describe("Commit SHA or branch to tag. Default: default branch."),
      message: z.string().max(10_000).optional().describe("If set, creates an annotated tag with this message."),
      tagger_name: z.string().optional(),
      tagger_email: z.string().email().optional(),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const target = a.target ?? (await getDefaultBranch(gh, a.owner, a.repo));
      const commitSha = await resolveCommitSha(gh, a.owner, a.repo, target);
      let refSha = commitSha;
      if (a.message) {
        const tagger = a.tagger_name && a.tagger_email ? { name: a.tagger_name, email: a.tagger_email, date: new Date().toISOString() } : undefined;
        const t = await gh.post<{ sha: string }>(`${repoPath(a.owner, a.repo)}/git/tags`, { tag: a.tag, message: a.message, object: commitSha, type: "commit", tagger });
        refSha = t.sha;
      }
      await gh.post(`${repoPath(a.owner, a.repo)}/git/refs`, { ref: `refs/tags/${a.tag}`, sha: refSha });
      return { created_tag: a.tag, kind: a.message ? "annotated" : "lightweight", commit_sha: commitSha };
    },
  }),
];
