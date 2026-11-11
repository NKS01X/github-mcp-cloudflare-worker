import { z } from "zod";
import { compact, pick, truncate } from "../github/compact";
import { enc, type GitHubClient } from "../github/client";
import { GitHubApiError } from "../github/errors";
import { TextResult, defineTool, pagination, repoArgs } from "./define";

const repoPath = (o: string, r: string) => `/repos/${enc(o)}/${enc(r)}`;
const workflowId = z.union([z.number().int().positive(), z.string().min(1)]).describe("Workflow ID or workflow file name, e.g. 'ci.yml'.");
const runId = z.number().int().positive().describe("Workflow run ID.");

function runSummary(r: Record<string, unknown>) {
  return compact(
    pick(r, ["id", "name", "display_title", "event", "status", "conclusion", "head_branch", "head_sha", "run_number", "run_attempt", "actor", "created_at", "updated_at", "run_started_at", "html_url"]),
  );
}

function jobSummary(j: Record<string, unknown>, withSteps: boolean) {
  const s = compact(pick(j, ["id", "name", "status", "conclusion", "started_at", "completed_at", "runner_name", "html_url"])) as Record<string, unknown>;
  if (withSteps) s.steps = ((j.steps as Array<Record<string, unknown>>) ?? []).map((st) => pick(st, ["number", "name", "status", "conclusion"]));
  return s;
}

/** Job logs redirect to a short-lived signed URL; download it without our GitHub token. */
async function jobLogs(gh: GitHubClient, owner: string, repo: string, jobId: number): Promise<string> {
  const res = await gh.request("GET", `${repoPath(owner, repo)}/actions/jobs/${jobId}/logs`, { redirect: "manual", responseType: "text" });
  const location = res.headers.get("location");
  if (location) return gh.fetchRedirectTarget(location);
  if (typeof res.data === "string") return res.data;
  throw new GitHubApiError(404, "Logs are not available for this job.", "Logs expire after the repository's retention period, and are unavailable while a job is queued.");
}

function tailLines(text: string, lines: number): string {
  const all = text.split("\n");
  return all.length <= lines ? text : `… [${all.length - lines} earlier lines omitted]\n${all.slice(-lines).join("\n")}`;
}

export const actionsTools = [
  defineTool({
    name: "list_workflows",
    toolset: "actions",
    title: "List GitHub Actions workflows",
    description: "List the GitHub Actions workflows defined in a repository (name, file path, state).",
    input: z.object({ ...repoArgs, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p, raw } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/actions/workflows`, { per_page: a.per_page, page: a.page });
      return { total_count: (raw as Record<string, unknown>).total_count, workflows: items.map((w) => pick(w, ["id", "name", "path", "state", "html_url"])), pagination: p };
    },
  }),

  defineTool({
    name: "get_workflow",
    toolset: "actions",
    title: "Get a workflow",
    description: "Get a workflow's details (ID, name, path, state). Read its YAML with get_file_contents using the returned path.",
    input: z.object({ ...repoArgs, workflow_id: workflowId }),
    readOnly: true,
    handler: async (a, { gh }) => pick(await gh.get(`${repoPath(a.owner, a.repo)}/actions/workflows/${enc(a.workflow_id)}`), ["id", "name", "path", "state", "created_at", "updated_at", "html_url", "badge_url"]),
  }),

  defineTool({
    name: "run_workflow",
    toolset: "actions",
    title: "Trigger a workflow run",
    description:
      "Trigger a workflow that has an 'on: workflow_dispatch' trigger, on a branch or tag, with optional inputs. Returns the new run's ID when GitHub provides it. Fails with 422 if the workflow has no workflow_dispatch trigger.",
    input: z.object({
      ...repoArgs,
      workflow_id: workflowId,
      ref: z.string().min(1).describe("Branch or tag to run on, e.g. 'main'."),
      inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("workflow_dispatch inputs."),
    }),
    readOnly: false,
    handler: async (a, { gh }) => {
      const inputs = a.inputs ? Object.fromEntries(Object.entries(a.inputs).map(([k, v]) => [k, String(v)])) : undefined;
      const res = await gh.request<Record<string, unknown> | undefined>("POST", `${repoPath(a.owner, a.repo)}/actions/workflows/${enc(a.workflow_id)}/dispatches`, { body: { ref: a.ref, inputs } });
      return {
        triggered: true,
        workflow: a.workflow_id,
        ref: a.ref,
        ...(res.data && typeof res.data === "object" ? { run: compact(res.data) } : { note: "Use list_workflow_runs to find the new run (it can take a few seconds to appear)." }),
      };
    },
  }),

  defineTool({
    name: "list_workflow_runs",
    toolset: "actions",
    title: "List workflow runs",
    description: "List recent workflow runs for the whole repository or one workflow, filtered by branch, event, status (e.g. 'failure', 'in_progress', 'success') or actor.",
    input: z.object({
      ...repoArgs,
      workflow_id: workflowId.optional(),
      branch: z.string().optional(),
      event: z.string().optional().describe("e.g. 'push', 'pull_request', 'workflow_dispatch'."),
      status: z
        .enum(["completed", "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "success", "timed_out", "in_progress", "queued", "requested", "waiting", "pending"])
        .optional(),
      actor: z.string().optional(),
      head_sha: z.string().optional(),
      ...pagination,
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const path = a.workflow_id ? `${repoPath(a.owner, a.repo)}/actions/workflows/${enc(a.workflow_id)}/runs` : `${repoPath(a.owner, a.repo)}/actions/runs`;
      const { items, pagination: p, raw } = await gh.getPage<Record<string, unknown>>(path, {
        branch: a.branch, event: a.event, status: a.status, actor: a.actor, head_sha: a.head_sha, per_page: a.per_page, page: a.page,
      });
      return { total_count: (raw as Record<string, unknown>).total_count, runs: items.map(runSummary), pagination: p };
    },
  }),

  defineTool({
    name: "get_workflow_run",
    toolset: "actions",
    title: "Get a workflow run",
    description: "Get the status and conclusion of a workflow run, plus a summary of its jobs.",
    input: z.object({ ...repoArgs, run_id: runId }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const [run, jobs] = await Promise.all([
        gh.get<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/actions/runs/${a.run_id}`),
        gh.get<{ jobs: Array<Record<string, unknown>> }>(`${repoPath(a.owner, a.repo)}/actions/runs/${a.run_id}/jobs`, { per_page: 100 }),
      ]);
      return { ...(runSummary(run) as Record<string, unknown>), jobs: jobs.jobs.map((j) => jobSummary(j, false)) };
    },
  }),

  defineTool({
    name: "list_workflow_run_jobs",
    toolset: "actions",
    title: "List jobs of a workflow run",
    description: "List the jobs (with steps) of a workflow run. filter 'latest' shows the latest attempt only.",
    input: z.object({ ...repoArgs, run_id: runId, filter: z.enum(["latest", "all"]).default("latest"), ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/actions/runs/${a.run_id}/jobs`, { filter: a.filter, per_page: a.per_page, page: a.page });
      return { jobs: items.map((j) => jobSummary(j, true)), pagination: p };
    },
  }),

  defineTool({
    name: "get_job",
    toolset: "actions",
    title: "Get a workflow job",
    description: "Get one job's status, conclusion, runner and steps.",
    input: z.object({ ...repoArgs, job_id: z.number().int().positive() }),
    readOnly: true,
    handler: async (a, { gh }) => jobSummary(await gh.get(`${repoPath(a.owner, a.repo)}/actions/jobs/${a.job_id}`), true),
  }),

  defineTool({
    name: "get_job_logs",
    toolset: "actions",
    title: "Get a job's logs",
    description: "Download the log output of one workflow job (last tail_lines lines by default, since errors are usually at the end).",
    input: z.object({
      ...repoArgs,
      job_id: z.number().int().positive(),
      tail_lines: z.number().int().min(10).max(20_000).default(300),
      max_chars: z.number().int().min(1000).max(300_000).default(60_000),
    }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const log = await jobLogs(gh, a.owner, a.repo, a.job_id);
      const t = truncate(tailLines(log, a.tail_lines), a.max_chars);
      return new TextResult(`job_id: ${a.job_id}\n--- log (tail) ---\n${t.text}`, { job_id: a.job_id, truncated: t.truncated });
    },
  }),

  defineTool({
    name: "get_failed_job_logs",
    toolset: "actions",
    title: "Get logs of failed jobs in a run",
    description: "For a workflow run, find the failed jobs and return the tail of each one's log — the quickest way to see why CI failed.",
    input: z.object({ ...repoArgs, run_id: runId, tail_lines: z.number().int().min(10).max(5000).default(150), max_jobs: z.number().int().min(1).max(10).default(5) }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const jobs = await gh.get<{ jobs: Array<Record<string, unknown>> }>(`${repoPath(a.owner, a.repo)}/actions/runs/${a.run_id}/jobs`, { per_page: 100, filter: "latest" });
      const failed = jobs.jobs.filter((j) => ["failure", "timed_out", "cancelled", "startup_failure"].includes(String(j.conclusion)));
      if (failed.length === 0) return new TextResult(`No failed jobs in run ${a.run_id}. Jobs: ${jobs.jobs.map((j) => `${j.name}=${j.conclusion ?? j.status}`).join(", ")}`, { run_id: a.run_id, failed_jobs: 0 });
      const parts: string[] = [];
      for (const j of failed.slice(0, a.max_jobs)) {
        const steps = ((j.steps as Array<Record<string, unknown>>) ?? []).filter((s) => s.conclusion === "failure").map((s) => s.name);
        let log: string;
        try {
          log = tailLines(await jobLogs(gh, a.owner, a.repo, Number(j.id)), a.tail_lines);
        } catch (err) {
          log = `(logs unavailable: ${(err as Error).message})`;
        }
        parts.push(`=== job ${j.id} "${j.name}" — ${j.conclusion}${steps.length ? ` (failed step: ${steps.join(", ")})` : ""} ===\n${log}`);
      }
      const t = truncate(parts.join("\n\n"), 120_000);
      return new TextResult(t.text, { run_id: a.run_id, failed_jobs: failed.length, truncated: t.truncated });
    },
  }),

  defineTool({
    name: "cancel_workflow_run",
    toolset: "actions",
    title: "Cancel a workflow run",
    description: "Cancel a queued or in-progress workflow run.",
    input: z.object({ ...repoArgs, run_id: runId, force: z.boolean().default(false).describe("Force-cancel, bypassing 'always()' conditions.") }),
    readOnly: false,
    handler: async (a, { gh }) => {
      await gh.post(`${repoPath(a.owner, a.repo)}/actions/runs/${a.run_id}/${a.force ? "force-cancel" : "cancel"}`);
      return { cancel_requested: a.run_id };
    },
  }),

  defineTool({
    name: "rerun_workflow_run",
    toolset: "actions",
    title: "Re-run a workflow run",
    description: "Re-run a completed workflow run — all jobs, or only the failed ones (only_failed: true).",
    input: z.object({ ...repoArgs, run_id: runId, only_failed: z.boolean().default(false), enable_debug_logging: z.boolean().default(false) }),
    readOnly: false,
    handler: async (a, { gh }) => {
      await gh.post(`${repoPath(a.owner, a.repo)}/actions/runs/${a.run_id}/${a.only_failed ? "rerun-failed-jobs" : "rerun"}`, { enable_debug_logging: a.enable_debug_logging });
      return { rerun_requested: a.run_id, only_failed: a.only_failed };
    },
  }),

  defineTool({
    name: "rerun_job",
    toolset: "actions",
    title: "Re-run a single job",
    description: "Re-run one job of a workflow run (and jobs that depend on it).",
    input: z.object({ ...repoArgs, job_id: z.number().int().positive(), enable_debug_logging: z.boolean().default(false) }),
    readOnly: false,
    handler: async (a, { gh }) => {
      await gh.post(`${repoPath(a.owner, a.repo)}/actions/jobs/${a.job_id}/rerun`, { enable_debug_logging: a.enable_debug_logging });
      return { rerun_requested_job: a.job_id };
    },
  }),

  defineTool({
    name: "list_workflow_run_artifacts",
    toolset: "actions",
    title: "List workflow run artifacts",
    description: "List the artifacts a workflow run uploaded (name, size, expiry). Artifacts are zip files downloadable from GitHub's web UI.",
    input: z.object({ ...repoArgs, run_id: runId, ...pagination }),
    readOnly: true,
    handler: async (a, { gh }) => {
      const { items, pagination: p } = await gh.getPage<Record<string, unknown>>(`${repoPath(a.owner, a.repo)}/actions/runs/${a.run_id}/artifacts`, { per_page: a.per_page, page: a.page });
      return { artifacts: items.map((x) => pick(x, ["id", "name", "size_in_bytes", "expired", "created_at", "expires_at"])), pagination: p };
    },
  }),

  defineTool({
    name: "set_workflow_enabled",
    toolset: "actions",
    title: "Enable or disable a workflow",
    description: "Enable or disable a workflow so it does or does not run on its triggers.",
    input: z.object({ ...repoArgs, workflow_id: workflowId, enabled: z.boolean() }),
    readOnly: false,
    idempotent: true,
    handler: async (a, { gh }) => {
      await gh.put(`${repoPath(a.owner, a.repo)}/actions/workflows/${enc(a.workflow_id)}/${a.enabled ? "enable" : "disable"}`);
      return { workflow: a.workflow_id, enabled: a.enabled };
    },
  }),
];

