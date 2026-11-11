/** GitHub Discussions are only available through the GraphQL API. */
import { z } from "zod";
import { GitHubApiError } from "../github/errors";
import type { GitHubClient } from "../github/client";
import { defineTool, repoArgs } from "./define";

const first = z.number().int().min(1).max(100).default(20).describe("How many items to return (max 100).");
const after = z.string().optional().describe("Pagination cursor: end_cursor from the previous result.");

async function discussionId(gh: GitHubClient, owner: string, repo: string, number: number): Promise<string> {
  const d = await gh.graphql<{ repository: { discussion: { id: string } | null } }>(
    "query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ discussion(number:$n){ id } } }",
    { o: owner, r: repo, n: number },
  );
  if (!d.repository?.discussion) throw new GitHubApiError(404, `Discussion #${number} not found.`, "Check the number, and that Discussions are enabled for the repository.");
  return d.repository.discussion.id;
}

export const discussionTools = [
  defineTool({
    name: "list_discussion_categories",
    toolset: "discussions",
    title: "List discussion categories",
    description: "List a repository's discussion categories with their IDs (needed by create_discussion). Fails if Discussions are disabled.",
    input: z.object({ ...repoArgs }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const d = await gh.graphql<{ repository: { hasDiscussionsEnabled: boolean; discussionCategories: { nodes: Array<Record<string, unknown>> } } }>(
        "query($o:String!,$r:String!){ repository(owner:$o,name:$r){ hasDiscussionsEnabled discussionCategories(first:50){ nodes { id name slug emoji description isAnswerable } } } }",
        { o: a.owner, r: a.repo },
      );
      return { discussions_enabled: d.repository.hasDiscussionsEnabled, categories: d.repository.discussionCategories.nodes };
    },
  }),

  defineTool({
    name: "list_discussions",
    toolset: "discussions",
    title: "List discussions",
    description: "List discussions in a repository, newest first, optionally in one category.",
    input: z.object({ ...repoArgs, category_id: z.string().optional().describe("From list_discussion_categories."), first, after }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const d = await gh.graphql<{ repository: { discussions: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Array<Record<string, unknown>> } } }>(
        `query($o:String!,$r:String!,$first:Int!,$after:String,$cat:ID){ repository(owner:$o,name:$r){
          discussions(first:$first, after:$after, categoryId:$cat, orderBy:{field:CREATED_AT, direction:DESC}){
            totalCount pageInfo { hasNextPage endCursor }
            nodes { number title url createdAt updatedAt closed isAnswered author { login } category { name } comments { totalCount } } } } }`,
        { o: a.owner, r: a.repo, first: a.first, after: a.after, cat: a.category_id },
      );
      const ds = d.repository.discussions;
      return {
        total: ds.totalCount,
        discussions: ds.nodes.map((n) => ({ ...n, author: (n.author as { login: string } | null)?.login, category: (n.category as { name: string }).name, comments: (n.comments as { totalCount: number }).totalCount })),
        has_next_page: ds.pageInfo.hasNextPage,
        end_cursor: ds.pageInfo.endCursor,
      };
    },
  }),

  defineTool({
    name: "get_discussion",
    toolset: "discussions",
    title: "Get a discussion with comments",
    description: "Get a discussion's body and its comments (with replies).",
    input: z.object({ ...repoArgs, discussion_number: z.number().int().positive(), comments_first: first, comments_after: after }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const d = await gh.graphql<{ repository: { discussion: Record<string, unknown> | null } }>(
        `query($o:String!,$r:String!,$n:Int!,$first:Int!,$after:String){ repository(owner:$o,name:$r){ discussion(number:$n){
          id number title body url createdAt closed isAnswered author { login } category { name }
          answer { id }
          comments(first:$first, after:$after){ totalCount pageInfo { hasNextPage endCursor }
            nodes { id body createdAt isAnswer author { login } replies(first:20){ nodes { id body createdAt author { login } } } } } } } }`,
        { o: a.owner, r: a.repo, n: a.discussion_number, first: a.comments_first, after: a.comments_after },
      );
      if (!d.repository.discussion) throw new GitHubApiError(404, `Discussion #${a.discussion_number} not found.`, "Check the number.");
      return d.repository.discussion;
    },
  }),

  defineTool({
    name: "create_discussion",
    toolset: "discussions",
    title: "Start a discussion",
    description: "Create a new discussion in a category (get category_id from list_discussion_categories).",
    input: z.object({ ...repoArgs, category_id: z.string().min(1), title: z.string().min(1).max(256), body: z.string().min(1).max(65_536) }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const r = await gh.graphql<{ repository: { id: string } }>("query($o:String!,$r:String!){ repository(owner:$o,name:$r){ id } }", { o: a.owner, r: a.repo });
      const res = await gh.graphql<{ createDiscussion: { discussion: { number: number; url: string } } }>(
        "mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){ createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){ discussion { number url } } }",
        { repo: r.repository.id, cat: a.category_id, title: a.title, body: a.body },
      );
      return res.createDiscussion.discussion;
    },
  }),

  defineTool({
    name: "add_discussion_comment",
    toolset: "discussions",
    title: "Comment on a discussion",
    description: "Add a comment to a discussion, or reply to an existing comment (reply_to_comment_id from get_discussion).",
    input: z.object({ ...repoArgs, discussion_number: z.number().int().positive(), body: z.string().min(1).max(65_536), reply_to_comment_id: z.string().optional() }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const id = await discussionId(gh, a.owner, a.repo, a.discussion_number);
      const res = await gh.graphql<{ addDiscussionComment: { comment: { id: string; url: string } } }>(
        "mutation($d:ID!,$body:String!,$reply:ID){ addDiscussionComment(input:{discussionId:$d,body:$body,replyToId:$reply}){ comment { id url } } }",
        { d: id, body: a.body, reply: a.reply_to_comment_id },
      );
      return res.addDiscussionComment.comment;
    },
  }),

  defineTool({
    name: "close_discussion",
    toolset: "discussions",
    title: "Close or reopen a discussion",
    description: "Close a discussion (reason RESOLVED, OUTDATED or DUPLICATE) or reopen it.",
    input: z.object({ ...repoArgs, discussion_number: z.number().int().positive(), action: z.enum(["close", "reopen"]), reason: z.enum(["RESOLVED", "OUTDATED", "DUPLICATE"]).default("RESOLVED") }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      const id = await discussionId(gh, a.owner, a.repo, a.discussion_number);
      if (a.action === "close") {
        await gh.graphql("mutation($d:ID!,$reason:DiscussionCloseReason){ closeDiscussion(input:{discussionId:$d,reason:$reason}){ discussion { closed } } }", { d: id, reason: a.reason });
      } else {
        await gh.graphql("mutation($d:ID!){ reopenDiscussion(input:{discussionId:$d}){ discussion { closed } } }", { d: id });
      }
      return { discussion_number: a.discussion_number, closed: a.action === "close" };
    },
  }),
];
