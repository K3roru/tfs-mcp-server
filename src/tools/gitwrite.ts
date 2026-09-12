import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describeError } from "../client.js";
import { resolveProject } from "../config.js";
import type { ToolContext } from "../context.js";
import { getRepository, type RawRepository } from "../services/git.js";
import {
  branchWebUrl,
  commitWebUrl,
  createBranch,
  createPullRequest,
  ensureWorkItemsLinked,
  findBranchTip,
  getBranchTip,
  pullRequestWebUrl,
  pushCommit,
  resolveChanges,
  stripHeads,
  type FileChange,
  type RawPullRequest,
  type WorkItemLinkResult,
} from "../services/gitwrite.js";
import { fail, guard, ok } from "../util/result.js";

/* ------------------------------------------------------------------------------------------------
 * Shared schema fragments
 * ---------------------------------------------------------------------------------------------- */

const projectArg = z
  .string()
  .min(1)
  .optional()
  .describe("Team project name or id that owns the repository. Overrides TFS_DEFAULT_PROJECT.");

const repositoryArg = z.string().min(1).describe("Repository name or id.");

const fileEditSchema = z.object({
  find: z.string().min(1).describe("Exact text to find in the current file (must occur exactly once unless replaceAll is true)."),
  replace: z.string().describe("Replacement text (may be empty to delete the found text)."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
});

const fileChangeSchema = z.object({
  path: z.string().min(1).describe("File path inside the repository, e.g. '/src/app/main.ts'."),
  changeType: z.enum(["add", "edit", "delete"]).describe("'add' creates a new file, 'edit' changes an existing one, 'delete' removes it."),
  content: z.string().optional().describe("Full new file content (add/edit). Mutually exclusive with 'edits'."),
  encoding: z.enum(["utf-8", "base64"]).optional().describe("How 'content' is encoded; default utf-8 text. Use base64 for binary files."),
  edits: z
    .array(fileEditSchema)
    .min(1)
    .optional()
    .describe("Exact find/replace edits applied in order to the current file content (edit only). Mutually exclusive with 'content'."),
});

const changesArg = z.array(fileChangeSchema).min(1).max(50).describe("File changes included in the single commit (add / edit / delete).");
const messageArg = z.string().min(1).describe("Commit message.");
const workItemIdsArg = z.array(z.number().int().positive()).max(50).optional().describe("Work item ids to link to the pull request.");
const reviewersArg = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .describe("Identity ids of reviewers to add (use search_identities / get_current_identity to resolve them).");
const isDraftArg = z.boolean().optional().describe("Create the pull request as a draft.");

/* ------------------------------------------------------------------------------------------------
 * Views
 * ---------------------------------------------------------------------------------------------- */

function pullRequestView(pr: RawPullRequest, repo: RawRepository, project: string, repository: string, workItems: WorkItemLinkResult[]) {
  return {
    pullRequestId: pr.pullRequestId,
    title: pr.title,
    description: pr.description,
    status: pr.status,
    isDraft: pr.isDraft,
    mergeStatus: pr.mergeStatus,
    sourceBranch: pr.sourceRefName ? stripHeads(pr.sourceRefName) : undefined,
    targetBranch: pr.targetRefName ? stripHeads(pr.targetRefName) : undefined,
    repository,
    project,
    createdBy: pr.createdBy?.displayName,
    creationDate: pr.creationDate,
    reviewers: pr.reviewers?.map((r) => ({ id: r.id, displayName: r.displayName })),
    workItems,
    webUrl: pullRequestWebUrl(repo, pr),
  };
}

function summarizeLinks(workItems: WorkItemLinkResult[]): string {
  if (workItems.length === 0) return "";
  const linked = workItems.filter((w) => w.linked).length;
  return linked === workItems.length ? `, linked ${linked} work item(s)` : `, linked ${linked}/${workItems.length} work item(s)`;
}

/* ------------------------------------------------------------------------------------------------
 * Registration
 * ---------------------------------------------------------------------------------------------- */

export function registerGitWriteTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  /* ---------------------------------- create_branch ---------------------------------- */
  server.registerTool(
    "create_branch",
    {
      title: "Create branch",
      description:
        "Create a new Git branch from an existing branch (default: the repository's default branch) or from a commit. " +
        "Fails when the branch already exists unless ifExists is 'reuse'.",
      inputSchema: {
        repository: repositoryArg,
        project: projectArg,
        name: z.string().min(1).describe("New branch name, e.g. 'feature/1234-fix-login' (without 'refs/heads/')."),
        fromBranch: z.string().optional().describe("Branch to branch off from. Defaults to the repository's default branch."),
        fromCommit: z.string().optional().describe("Commit SHA to branch off from (alternative to fromBranch)."),
        ifExists: z.enum(["fail", "reuse"]).default("fail").describe("What to do when the branch already exists."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(
      async ({ repository, project, name, fromBranch, fromCommit, ifExists }) => {
        const proj = resolveProject(config, project, true);
        const result = await createBranch(client, { project: proj, repository, name, fromBranch, fromCommit, ifExists });
        const data = {
          branch: result.branch,
          refName: result.refName,
          objectId: result.objectId,
          created: result.created,
          sourceBranch: result.source.branch,
          sourceCommit: result.source.commit,
          repository,
          project: proj,
          webUrl: branchWebUrl(result.repository, result.branch),
        };
        return ok(
          result.created
            ? `Created branch '${result.branch}' from ${result.source.branch ? `'${result.source.branch}'` : "commit"} @ ${result.source.commit}`
            : `Branch '${result.branch}' already exists @ ${result.objectId} (reused)`,
          data
        );
      },
      ({ repository, name }) => `Failed to create branch '${name}' in repository '${repository}'`
    )
  );

  /* ---------------------------------- commit_file_changes ---------------------------------- */
  server.registerTool(
    "commit_file_changes",
    {
      title: "Commit file changes",
      description:
        "Create one commit on an existing branch that adds, edits or deletes files. Each edit is either the full new 'content' " +
        "(utf-8 or base64) or a list of exact find/replace 'edits' applied to the current file. Fails if the branch tip moved " +
        "since expectedBranchTip (when given) or if an edit's 'find' text is missing or ambiguous.",
      inputSchema: {
        repository: repositoryArg,
        project: projectArg,
        branch: z.string().min(1).describe("Branch to commit to (must exist)."),
        message: messageArg,
        changes: changesArg,
        expectedBranchTip: z.string().optional().describe("Optional commit SHA the branch is expected to point at; the commit is refused otherwise."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      async ({ repository, project, branch, message, changes, expectedBranchTip }) => {
        const proj = resolveProject(config, project, true);
        const [repo, tip] = await Promise.all([getRepository(client, proj, repository), getBranchTip(client, proj, repository, branch)]);
        if (expectedBranchTip && expectedBranchTip !== tip) {
          throw new Error(`Branch '${stripHeads(branch)}' is at ${tip}, not at the expected ${expectedBranchTip}. Re-read the files and retry.`);
        }
        const resolved = await resolveChanges(client, { project: proj, repository, branchTip: tip }, changes as FileChange[]);
        const push = await pushCommit(client, { project: proj, repository, branch, oldObjectId: tip, message, changes: resolved });
        const data = {
          commitId: push.commitId,
          pushId: push.pushId,
          branch: stripHeads(branch),
          previousTip: tip,
          repository,
          project: proj,
          message,
          changes: resolved.map((c) => ({ path: c.path, changeType: c.changeType, appliedEdits: c.appliedEdits, bytes: c.bytes })),
          webUrl: commitWebUrl(repo, push.commitId),
        };
        return ok(`Committed ${resolved.length} change(s) to '${data.branch}' as ${push.commitId}`, data);
      },
      ({ repository, branch }) => `Failed to commit to branch '${branch}' in repository '${repository}'`
    )
  );

  /* ---------------------------------- create_pull_request ---------------------------------- */
  server.registerTool(
    "create_pull_request",
    {
      title: "Create pull request",
      description:
        "Open a pull request from a source branch into a target branch, optionally linking work items and adding reviewers. " +
        "Work items are passed to TFS on creation and, if TFS does not record the link, linked explicitly from the work item side.",
      inputSchema: {
        repository: repositoryArg,
        project: projectArg,
        sourceBranch: z.string().min(1).describe("Branch with the changes."),
        targetBranch: z.string().min(1).describe("Branch to merge into."),
        title: z.string().min(1).describe("Pull request title."),
        description: z.string().optional().describe("Pull request description (markdown)."),
        workItemIds: workItemIdsArg,
        reviewers: reviewersArg,
        isDraft: isDraftArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(
      async ({ repository, project, sourceBranch, targetBranch, title, description, workItemIds, reviewers, isDraft }) => {
        const proj = resolveProject(config, project, true);
        const repo = await getRepository(client, proj, repository);
        const pr = await createPullRequest(client, {
          project: proj,
          repository,
          sourceBranch,
          targetBranch,
          title,
          description,
          workItemIds,
          reviewerIds: reviewers,
          isDraft,
        });
        const links = await ensureWorkItemsLinked(client, { project: proj, repository, pullRequestId: pr.pullRequestId, repo, workItemIds: workItemIds ?? [] });
        const data = pullRequestView(pr, repo, proj, repository, links);
        return ok(`Created pull request #${pr.pullRequestId} '${pr.title ?? title}' (${data.sourceBranch} -> ${data.targetBranch})${summarizeLinks(links)}`, data);
      },
      ({ repository, sourceBranch, targetBranch }) => `Failed to create pull request ${sourceBranch} -> ${targetBranch} in repository '${repository}'`
    )
  );

  /* ---------------------------------- create_branch_commit_and_pull_request ---------------------------------- */
  server.registerTool(
    "create_branch_commit_and_pull_request",
    {
      title: "Create branch, commit changes and open pull request",
      description:
        "One-shot workflow: create newBranch from targetBranch, commit the given file changes to it (full content or find/replace edits), " +
        "then open a pull request newBranch -> targetBranch linked to the given work items. If a later step fails, the error reports " +
        "which steps already succeeded so you can continue with create_branch / commit_file_changes / create_pull_request.",
      inputSchema: {
        repository: repositoryArg,
        project: projectArg,
        newBranch: z.string().min(1).describe("Name of the branch to create, e.g. 'feature/1234-fix-login'."),
        targetBranch: z.string().min(1).describe("Existing branch to branch off from and to merge back into."),
        message: messageArg,
        changes: changesArg,
        title: z.string().min(1).optional().describe("Pull request title. Defaults to the commit message."),
        description: z.string().optional().describe("Pull request description (markdown)."),
        workItemIds: workItemIdsArg,
        reviewers: reviewersArg,
        isDraft: isDraftArg,
        reuseExistingBranch: z.boolean().default(false).describe("Continue on newBranch if it already exists instead of failing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ repository, project, newBranch, targetBranch, message, changes, title, description, workItemIds, reviewers, isDraft, reuseExistingBranch }) => {
      const steps: { branch?: unknown; commit?: unknown; pullRequest?: unknown } = {};
      let step: "branch" | "commit" | "pullRequest" = "branch";
      try {
        const proj = resolveProject(config, project, true);

        // 1) branch
        const created = await createBranch(client, {
          project: proj,
          repository,
          name: newBranch,
          fromBranch: targetBranch,
          ifExists: reuseExistingBranch ? "reuse" : "fail",
        });
        const repo = created.repository;
        steps.branch = {
          branch: created.branch,
          objectId: created.objectId,
          created: created.created,
          sourceBranch: created.source.branch,
          sourceCommit: created.source.commit,
          webUrl: branchWebUrl(repo, created.branch),
        };

        // 2) commit
        step = "commit";
        const resolved = await resolveChanges(client, { project: proj, repository, branchTip: created.objectId }, changes as FileChange[]);
        const push = await pushCommit(client, { project: proj, repository, branch: created.branch, oldObjectId: created.objectId, message, changes: resolved });
        steps.commit = {
          commitId: push.commitId,
          pushId: push.pushId,
          message,
          changes: resolved.map((c) => ({ path: c.path, changeType: c.changeType, appliedEdits: c.appliedEdits, bytes: c.bytes })),
          webUrl: commitWebUrl(repo, push.commitId),
        };

        // 3) pull request
        step = "pullRequest";
        const pr = await createPullRequest(client, {
          project: proj,
          repository,
          sourceBranch: created.branch,
          targetBranch,
          title: title ?? message,
          description,
          workItemIds,
          reviewerIds: reviewers,
          isDraft,
        });
        const links = await ensureWorkItemsLinked(client, { project: proj, repository, pullRequestId: pr.pullRequestId, repo, workItemIds: workItemIds ?? [] });
        steps.pullRequest = pullRequestView(pr, repo, proj, repository, links);

        return ok(
          `Branch '${created.branch}' ${created.created ? "created" : "reused"}, commit ${push.commitId} (${resolved.length} change(s)), ` +
            `pull request #${pr.pullRequestId} -> '${stripHeads(targetBranch)}'${summarizeLinks(links)}`,
          { repository, project: proj, targetBranch: stripHeads(targetBranch), ...steps }
        );
      } catch (err) {
        return failWithSteps(err, step, steps, { repository, newBranch, targetBranch });
      }
    }
  );
}

/** Tool error that also tells the caller which workflow steps already succeeded. */
function failWithSteps(
  err: unknown,
  failedStep: "branch" | "commit" | "pullRequest",
  steps: { branch?: unknown; commit?: unknown; pullRequest?: unknown },
  args: { repository: string; newBranch: string; targetBranch: string }
): CallToolResult {
  const completed = (Object.keys(steps) as (keyof typeof steps)[]).filter((k) => steps[k] !== undefined);
  const stepLabel = { branch: "creating the branch", commit: "committing the changes", pullRequest: "creating the pull request" }[failedStep];
  const resume =
    failedStep === "commit"
      ? ` Branch '${stripHeads(args.newBranch)}' exists; fix the changes and call commit_file_changes, then create_pull_request.`
      : failedStep === "pullRequest"
        ? ` Branch and commit exist; call create_pull_request for '${stripHeads(args.newBranch)}' -> '${stripHeads(args.targetBranch)}'.`
        : "";
  const context =
    `Workflow failed while ${stepLabel} in repository '${args.repository}'` +
    (completed.length ? ` (completed steps: ${completed.join(", ")}).` : ".") +
    resume;
  const result = fail(err, context);
  result.structuredContent = { ...result.structuredContent, failedStep, completedSteps: completed, ...steps };
  const first = result.content[0];
  if (first && first.type === "text") first.text = `${context}\n${describeError(err)}\n\n${JSON.stringify(steps, null, 2)}`;
  return result;
}
