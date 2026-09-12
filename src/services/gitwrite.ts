import { isTfsApiError, type TfsClient } from "../client.js";
import { decodeBytes, getItem, getItemBytes, getRepository, listRefs, looksBinary, normalizePath, type RawRepository } from "./git.js";
import { updateWorkItemRaw } from "./workitems.js";

/* ------------------------------------------------------------------------------------------------
 * Raw TFS shapes
 * ---------------------------------------------------------------------------------------------- */

export const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";

export interface RawRefUpdateResult {
  name: string;
  oldObjectId?: string;
  newObjectId?: string;
  success?: boolean;
  updateStatus?: string;
  customMessage?: string;
  rejectedBy?: string;
}

export interface RawPush {
  pushId?: number;
  date?: string;
  url?: string;
  refUpdates?: { name: string; oldObjectId?: string; newObjectId?: string }[];
  commits?: { commitId: string; comment?: string; url?: string }[];
  _links?: Record<string, { href: string }>;
}

export interface RawPullRequest {
  pullRequestId: number;
  codeReviewId?: number;
  status?: string;
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: string;
  isDraft?: boolean;
  creationDate?: string;
  createdBy?: { displayName?: string; uniqueName?: string; id?: string };
  repository?: { id: string; name?: string; webUrl?: string; project?: { id: string; name?: string } };
  reviewers?: { id?: string; displayName?: string; vote?: number }[];
  workItemRefs?: { id: string; url?: string }[];
  url?: string;
  _links?: Record<string, { href: string }>;
}

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

function repoSegment(repository: string): string {
  return encodeURIComponent(repository);
}

export function stripHeads(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function toHeadsRef(branch: string): string {
  return `refs/heads/${stripHeads(branch.trim())}`;
}

export function branchWebUrl(repo: RawRepository | undefined, branch: string): string | undefined {
  return repo?.webUrl ? `${repo.webUrl}?version=GB${encodeURIComponent(stripHeads(branch))}` : undefined;
}

export function commitWebUrl(repo: RawRepository | undefined, commitId: string): string | undefined {
  return repo?.webUrl ? `${repo.webUrl}/commit/${commitId}` : undefined;
}

export function pullRequestWebUrl(repo: RawRepository | undefined, pr: RawPullRequest): string | undefined {
  const fromLinks = pr._links?.web?.href;
  if (fromLinks) return fromLinks;
  const webUrl = repo?.webUrl ?? pr.repository?.webUrl;
  return webUrl ? `${webUrl}/pullrequest/${pr.pullRequestId}` : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Branches
 * ---------------------------------------------------------------------------------------------- */

/** Tip commit of a branch, or undefined when the branch does not exist. */
export async function findBranchTip(client: TfsClient, project: string, repository: string, branch: string): Promise<string | undefined> {
  const name = stripHeads(branch);
  const refs = await listRefs(client, project, repository, `heads/${name}`);
  return refs.find((r) => r.name === `refs/heads/${name}`)?.objectId;
}

/** Tip commit of a branch; throws a descriptive error listing existing branches when it is missing. */
export async function getBranchTip(client: TfsClient, project: string, repository: string, branch: string): Promise<string> {
  const tip = await findBranchTip(client, project, repository, branch);
  if (tip) return tip;
  let available: string[] = [];
  try {
    available = (await listRefs(client, project, repository, "heads/", 50)).map((r) => stripHeads(r.name)).sort();
  } catch {
    /* ignore */
  }
  throw new Error(
    `Branch '${stripHeads(branch)}' does not exist in repository '${repository}' (project '${project}'). ` +
      `Branches (up to 50): ${available.join(", ") || "(none)"}.`
  );
}

export interface CreateBranchArgs {
  project: string;
  repository: string;
  name: string;
  /** Source branch; defaults to the repository's default branch when neither fromBranch nor fromCommit is given. */
  fromBranch?: string | undefined;
  /** Source commit SHA (alternative to fromBranch). */
  fromCommit?: string | undefined;
  ifExists?: "fail" | "reuse" | undefined;
}

export interface CreateBranchResult {
  branch: string;
  refName: string;
  objectId: string;
  created: boolean;
  source: { branch: string | undefined; commit: string };
  repository: RawRepository;
}

export async function createBranch(client: TfsClient, args: CreateBranchArgs): Promise<CreateBranchResult> {
  if (args.fromBranch && args.fromCommit) throw new Error("Specify only one of fromBranch or fromCommit.");
  const name = stripHeads(args.name.trim());
  if (!name) throw new Error("Branch name must not be empty.");
  const repo = await getRepository(client, args.project, args.repository);

  let sourceBranch: string | undefined;
  let sourceCommit: string;
  if (args.fromCommit) {
    sourceCommit = args.fromCommit;
  } else {
    sourceBranch = stripHeads(args.fromBranch ?? repo.defaultBranch ?? "");
    if (!sourceBranch) throw new Error(`Repository '${args.repository}' has no default branch; pass fromBranch or fromCommit.`);
    sourceCommit = await getBranchTip(client, args.project, args.repository, sourceBranch);
  }

  const existing = await findBranchTip(client, args.project, args.repository, name);
  if (existing) {
    if (args.ifExists === "reuse") {
      return { branch: name, refName: `refs/heads/${name}`, objectId: existing, created: false, source: { branch: sourceBranch, commit: sourceCommit }, repository: repo };
    }
    throw new Error(`Branch '${name}' already exists in repository '${args.repository}' (tip ${existing}). Use ifExists: "reuse" to continue on it.`);
  }

  const res = await client.post<{ count: number; value: RawRefUpdateResult[] }>({
    project: args.project,
    path: `git/repositories/${repoSegment(args.repository)}/refs`,
    body: [{ name: `refs/heads/${name}`, oldObjectId: ZERO_OBJECT_ID, newObjectId: sourceCommit }],
  });
  const update = res.value?.[0];
  if (!update || update.success === false) {
    throw new Error(
      `TFS rejected creation of branch '${name}': ${update?.updateStatus ?? "unknown status"}` +
        (update?.customMessage ? ` - ${update.customMessage}` : "") +
        (update?.rejectedBy ? ` (rejected by ${update.rejectedBy})` : "")
    );
  }
  return {
    branch: name,
    refName: `refs/heads/${name}`,
    objectId: update.newObjectId ?? sourceCommit,
    created: true,
    source: { branch: sourceBranch, commit: sourceCommit },
    repository: repo,
  };
}

/* ------------------------------------------------------------------------------------------------
 * File changes & commits
 * ---------------------------------------------------------------------------------------------- */

export interface FileEdit {
  find: string;
  replace: string;
  replaceAll?: boolean | undefined;
}

export interface FileChange {
  path: string;
  changeType: "add" | "edit" | "delete";
  /** Full new content (for add/edit). */
  content?: string | undefined;
  /** Encoding of `content`: utf-8 text (default) or base64 for binaries. */
  encoding?: "utf-8" | "base64" | undefined;
  /** Exact find/replace edits applied to the current file content (edit only; alternative to `content`). */
  edits?: FileEdit[] | undefined;
}

export interface ResolvedChange {
  path: string;
  changeType: FileChange["changeType"];
  content: string | undefined;
  contentType: "rawtext" | "base64encoded" | undefined;
  appliedEdits: number;
  bytes: number | undefined;
}

export function validateFileChange(change: FileChange): void {
  const path = normalizePath(change.path);
  if (path === "/") throw new Error("A file path is required for every change.");
  const hasContent = change.content !== undefined;
  const hasEdits = change.edits !== undefined && change.edits.length > 0;
  switch (change.changeType) {
    case "delete":
      if (hasContent || hasEdits) throw new Error(`'${path}': a delete change must not carry content or edits.`);
      break;
    case "add":
      if (hasEdits) throw new Error(`'${path}': edits are only valid for changeType 'edit' (the file must already exist).`);
      if (!hasContent) throw new Error(`'${path}': an add change requires 'content'.`);
      break;
    case "edit":
      if (hasContent && hasEdits) throw new Error(`'${path}': specify either 'content' or 'edits', not both.`);
      if (!hasContent && !hasEdits) throw new Error(`'${path}': an edit change requires 'content' or a non-empty 'edits' list.`);
      break;
  }
  if (change.encoding === "base64" && hasEdits) throw new Error(`'${path}': edits cannot be combined with base64 encoding.`);
}

/** Apply exact substring edits; every `find` must occur exactly once unless `replaceAll` is set. */
export function applyEdits(path: string, original: string, edits: FileEdit[]): string {
  let text = original;
  edits.forEach((edit, i) => {
    if (!edit.find) throw new Error(`'${path}': edit #${i + 1} has an empty 'find' string.`);
    const first = text.indexOf(edit.find);
    if (first < 0) throw new Error(`'${path}': edit #${i + 1} - text to find was not found:\n${edit.find}`);
    if (edit.replaceAll) {
      text = text.split(edit.find).join(edit.replace);
      return;
    }
    const second = text.indexOf(edit.find, first + edit.find.length);
    if (second >= 0) {
      throw new Error(`'${path}': edit #${i + 1} - text to find occurs more than once; add surrounding context or set replaceAll: true:\n${edit.find}`);
    }
    text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
  });
  if (text === original) throw new Error(`'${path}': edits produced no change to the file.`);
  return text;
}

async function readTextFile(client: TfsClient, project: string, repository: string, path: string, commit: string): Promise<string> {
  const itemArgs = { project, repository, path, version: { version: commit, versionType: "commit" as const } };
  let item;
  try {
    item = await getItem(client, itemArgs, true);
  } catch (err) {
    if (isTfsApiError(err) && err.status === 404) {
      throw new Error(`'${path}' does not exist at commit ${commit} in repository '${repository}'; use changeType 'add' to create it.`);
    }
    throw err;
  }
  if (item.isFolder || item.gitObjectType === "tree") throw new Error(`'${path}' is a directory, not a file.`);
  if (typeof item.content === "string" && item.contentMetadata?.isBinary !== true) return item.content;
  const bytes = await getItemBytes(client, itemArgs);
  if (item.contentMetadata?.isBinary === true || looksBinary(bytes)) throw new Error(`'${path}' is binary; edits require a text file (use 'content' with encoding 'base64').`);
  return decodeBytes(bytes, item.contentMetadata?.encoding);
}

/** Turn user-facing FileChange objects into concrete push changes, reading current files for `edits`. */
export async function resolveChanges(
  client: TfsClient,
  args: { project: string; repository: string; branchTip: string },
  changes: FileChange[]
): Promise<ResolvedChange[]> {
  changes.forEach(validateFileChange);
  const seen = new Set<string>();
  const resolved: ResolvedChange[] = [];
  for (const change of changes) {
    const path = normalizePath(change.path);
    if (seen.has(path)) throw new Error(`'${path}' appears more than once in the change list.`);
    seen.add(path);
    if (change.changeType === "delete") {
      resolved.push({ path, changeType: "delete", content: undefined, contentType: undefined, appliedEdits: 0, bytes: undefined });
      continue;
    }
    if (change.edits && change.edits.length > 0) {
      const original = await readTextFile(client, args.project, args.repository, path, args.branchTip);
      const content = applyEdits(path, original, change.edits);
      resolved.push({ path, changeType: "edit", content, contentType: "rawtext", appliedEdits: change.edits.length, bytes: Buffer.byteLength(content, "utf8") });
      continue;
    }
    const content = change.content ?? "";
    const base64 = change.encoding === "base64";
    resolved.push({
      path,
      changeType: change.changeType,
      content,
      contentType: base64 ? "base64encoded" : "rawtext",
      appliedEdits: 0,
      bytes: base64 ? Buffer.from(content, "base64").byteLength : Buffer.byteLength(content, "utf8"),
    });
  }
  return resolved;
}

export interface PushCommitArgs {
  project: string;
  repository: string;
  branch: string;
  /** Current tip of the branch (the push is rejected by TFS when it no longer matches). */
  oldObjectId: string;
  message: string;
  changes: ResolvedChange[];
}

export interface PushCommitResult {
  commitId: string;
  newObjectId: string;
  pushId: number | undefined;
  refName: string;
}

export async function pushCommit(client: TfsClient, args: PushCommitArgs): Promise<PushCommitResult> {
  if (!args.message.trim()) throw new Error("Commit message must not be empty.");
  if (args.changes.length === 0) throw new Error("At least one file change is required.");
  const refName = toHeadsRef(args.branch);
  const res = await client.post<RawPush>({
    project: args.project,
    path: `git/repositories/${repoSegment(args.repository)}/pushes`,
    body: {
      refUpdates: [{ name: refName, oldObjectId: args.oldObjectId }],
      commits: [
        {
          comment: args.message,
          changes: args.changes.map((c) =>
            c.changeType === "delete"
              ? { changeType: "delete", item: { path: c.path } }
              : { changeType: c.changeType, item: { path: c.path }, newContent: { content: c.content, contentType: c.contentType } }
          ),
        },
      ],
    },
  });
  const commitId = res.commits?.[0]?.commitId;
  const newObjectId = res.refUpdates?.[0]?.newObjectId ?? commitId;
  if (!commitId || !newObjectId) throw new Error("TFS accepted the push but returned no commit id.");
  return { commitId, newObjectId, pushId: res.pushId, refName };
}

/* ------------------------------------------------------------------------------------------------
 * Pull requests
 * ---------------------------------------------------------------------------------------------- */

export interface CreatePullRequestArgs {
  project: string;
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string | undefined;
  workItemIds?: number[] | undefined;
  reviewerIds?: string[] | undefined;
  isDraft?: boolean | undefined;
}

export async function createPullRequest(client: TfsClient, args: CreatePullRequestArgs): Promise<RawPullRequest> {
  if (!args.title.trim()) throw new Error("Pull request title must not be empty.");
  const source = toHeadsRef(args.sourceBranch);
  const target = toHeadsRef(args.targetBranch);
  if (source === target) throw new Error(`Source and target branch are both '${stripHeads(source)}'.`);
  const body: Record<string, unknown> = { sourceRefName: source, targetRefName: target, title: args.title };
  if (args.description !== undefined) body.description = args.description;
  if (args.isDraft !== undefined) body.isDraft = args.isDraft;
  if (args.workItemIds && args.workItemIds.length > 0) body.workItemRefs = args.workItemIds.map((id) => ({ id: String(id) }));
  if (args.reviewerIds && args.reviewerIds.length > 0) body.reviewers = args.reviewerIds.map((id) => ({ id }));
  return client.post<RawPullRequest>({
    project: args.project,
    path: `git/repositories/${repoSegment(args.repository)}/pullrequests`,
    body,
  });
}

export interface WorkItemLinkResult {
  id: number;
  linked: boolean;
  method: "workItemRefs" | "artifactLink" | undefined;
  error?: string | undefined;
}

/** Artifact URI TFS uses to link a work item to a pull request. */
export function pullRequestArtifactUri(projectId: string, repositoryId: string, pullRequestId: number): string {
  return `vstfs:///Git/PullRequestId/${projectId}%2F${repositoryId}%2F${pullRequestId}`;
}

/**
 * Make sure every work item is linked to the pull request. TFS usually honours `workItemRefs` on creation;
 * ids that are still missing get an explicit ArtifactLink relation added on the work item side.
 */
export async function ensureWorkItemsLinked(
  client: TfsClient,
  args: { project: string; repository: string; pullRequestId: number; repo: RawRepository; workItemIds: number[] }
): Promise<WorkItemLinkResult[]> {
  if (args.workItemIds.length === 0) return [];
  const ids = [...new Set(args.workItemIds)];

  let linkedIds = new Set<number>();
  try {
    const res = await client.get<{ count: number; value: { id: string; url?: string }[] }>({
      project: args.project,
      path: `git/repositories/${repoSegment(args.repository)}/pullRequests/${args.pullRequestId}/workitems`,
    });
    linkedIds = new Set((res.value ?? []).map((w) => Number(w.id)).filter((n) => Number.isFinite(n)));
  } catch {
    /* fall through: try to link every id explicitly */
  }

  const projectId = args.repo.project?.id;
  const repositoryId = args.repo.id;
  const results: WorkItemLinkResult[] = [];
  for (const id of ids) {
    if (linkedIds.has(id)) {
      results.push({ id, linked: true, method: "workItemRefs" });
      continue;
    }
    if (!projectId) {
      results.push({ id, linked: false, method: undefined, error: "Repository response has no project id; cannot build the pull request artifact link." });
      continue;
    }
    try {
      await updateWorkItemRaw(client, {
        id,
        patch: [
          {
            op: "add",
            path: "/relations/-",
            value: {
              rel: "ArtifactLink",
              url: pullRequestArtifactUri(projectId, repositoryId, args.pullRequestId),
              attributes: { name: "Pull Request" },
            },
          },
        ],
      });
      results.push({ id, linked: true, method: "artifactLink" });
    } catch (err) {
      const message = isTfsApiError(err) ? (err.tfsMessage ?? err.message) : err instanceof Error ? err.message : String(err);
      // TFS rejects duplicate relations; treat that as already linked.
      if (/already (exists|linked)|duplicate/i.test(message)) results.push({ id, linked: true, method: "artifactLink" });
      else results.push({ id, linked: false, method: "artifactLink", error: message });
    }
  }
  return results;
}
