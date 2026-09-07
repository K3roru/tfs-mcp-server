import type { TfsClient } from "../client.js";
import { htmlToText, textToHtml } from "../util/html.js";
import { chunk } from "../util/batch.js";

export const COMMENTS_API_VERSION = "6.0-preview.3";
export const WORKITEMS_BATCH_LIMIT = 200;

export type ContentFormat = "text" | "html";
export type ExpandOption = "none" | "relations" | "fields" | "links" | "all";

/* ------------------------------------------------------------------------------------------------
 * Raw TFS shapes (only the parts we use)
 * ---------------------------------------------------------------------------------------------- */

export interface IdentityRef {
  id?: string;
  displayName?: string;
  uniqueName?: string;
  descriptor?: string;
  imageUrl?: string;
  url?: string;
}

export interface RawWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: Record<string, unknown>;
  relations?: RawRelation[];
  _links?: Record<string, { href: string }>;
}

export interface RawRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

export interface RawComment {
  id: number;
  workItemId: number;
  version: number;
  text: string;
  renderedText?: string;
  createdBy?: IdentityRef;
  createdDate?: string;
  modifiedBy?: IdentityRef;
  modifiedDate?: string;
  isDeleted?: boolean;
  url?: string;
}

export interface RawCommentList {
  totalCount: number;
  count: number;
  comments: RawComment[];
  nextPage?: string;
  continuationToken?: string;
}

export interface RawQuery {
  id: string;
  name: string;
  path: string;
  wiql?: string;
  queryType?: "flat" | "tree" | "oneHop";
  isFolder?: boolean;
  isPublic?: boolean;
  columns?: { referenceName: string; name: string }[];
  sortColumns?: { field: { referenceName: string; name: string }; descending: boolean }[];
  createdBy?: IdentityRef;
  createdDate?: string;
  lastModifiedBy?: IdentityRef;
  lastModifiedDate?: string;
  hasChildren?: boolean;
  children?: RawQuery[];
  _links?: Record<string, { href: string }>;
}

export interface RawWiqlResult {
  queryType: "flat" | "tree" | "oneHop";
  queryResultType?: string;
  asOf?: string;
  columns?: { referenceName: string; name: string; url?: string }[];
  workItems?: { id: number; url: string }[];
  workItemRelations?: { rel?: string | null; source?: { id: number } | null; target: { id: number } }[];
}

/* ------------------------------------------------------------------------------------------------
 * Simplified shapes returned to the LLM
 * ---------------------------------------------------------------------------------------------- */

export interface Identity {
  displayName: string | undefined;
  uniqueName: string | undefined;
  id: string | undefined;
}

export interface WorkItemView {
  id: number;
  rev: number;
  url: string;
  webUrl: string | undefined;
  project: string | undefined;
  type: string | undefined;
  title: string | undefined;
  state: string | undefined;
  reason: string | undefined;
  assignedTo: Identity | undefined;
  areaPath: string | undefined;
  iterationPath: string | undefined;
  tags: string[];
  priority: number | undefined;
  createdBy: Identity | undefined;
  createdDate: string | undefined;
  changedBy: Identity | undefined;
  changedDate: string | undefined;
  parentId: number | undefined;
  content: {
    description: string | undefined;
    reproSteps: string | undefined;
    acceptanceCriteria: string | undefined;
  };
  fields: Record<string, unknown>;
  relations: RelationView[] | undefined;
  comments?: CommentView[] | undefined;
}

export interface RelationView {
  rel: string;
  name: string | undefined;
  workItemId: number | undefined;
  url: string;
  attributes: Record<string, unknown> | undefined;
}

export interface CommentView {
  id: number;
  workItemId: number;
  version: number;
  text: string;
  createdBy: Identity | undefined;
  createdDate: string | undefined;
  modifiedBy: Identity | undefined;
  modifiedDate: string | undefined;
  isDeleted: boolean | undefined;
}

const RICH_TEXT_FIELDS = new Set([
  "System.Description",
  "Microsoft.VSTS.TCM.ReproSteps",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.TCM.SystemInfo",
  "System.History",
]);

const RELATION_NAMES: Record<string, string> = {
  "System.LinkTypes.Hierarchy-Forward": "Child",
  "System.LinkTypes.Hierarchy-Reverse": "Parent",
  "System.LinkTypes.Related": "Related",
  "System.LinkTypes.Dependency-Forward": "Successor",
  "System.LinkTypes.Dependency-Reverse": "Predecessor",
  "System.LinkTypes.Duplicate-Forward": "Duplicate",
  "System.LinkTypes.Duplicate-Reverse": "Duplicate Of",
  "Microsoft.VSTS.Common.TestedBy-Forward": "Tested By",
  "Microsoft.VSTS.Common.TestedBy-Reverse": "Tests",
  AttachedFile: "Attachment",
  Hyperlink: "Hyperlink",
  ArtifactLink: "Artifact",
};

export function toIdentity(value: unknown): Identity | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return { displayName: value, uniqueName: undefined, id: undefined };
  if (typeof value === "object") {
    const ref = value as IdentityRef;
    return { displayName: ref.displayName, uniqueName: ref.uniqueName, id: ref.id };
  }
  return undefined;
}

/** Format an identity as a value TFS accepts for System.AssignedTo. */
export function identityToAssignedToValue(identity: Identity | undefined): string | undefined {
  if (!identity) return undefined;
  if (identity.displayName && identity.uniqueName) return `${identity.displayName} <${identity.uniqueName}>`;
  return identity.uniqueName ?? identity.displayName;
}

function workItemIdFromUrl(url: string): number | undefined {
  const m = /\/workItems\/(\d+)(?:\?|$)/i.exec(url);
  return m?.[1] ? Number(m[1]) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : value === undefined || value === null ? undefined : String(value);
}

export function toRelationView(rel: RawRelation): RelationView {
  return {
    rel: rel.rel,
    name: RELATION_NAMES[rel.rel] ?? (rel.attributes?.name as string | undefined),
    workItemId: rel.rel.startsWith("System.LinkTypes") || rel.rel.startsWith("Microsoft.VSTS") ? workItemIdFromUrl(rel.url) : undefined,
    url: rel.url,
    attributes: rel.attributes,
  };
}

export function toCommentView(c: RawComment, format: ContentFormat): CommentView {
  return {
    id: c.id,
    workItemId: c.workItemId,
    version: c.version,
    text: format === "text" ? htmlToText(c.text) : c.text,
    createdBy: toIdentity(c.createdBy),
    createdDate: c.createdDate,
    modifiedBy: toIdentity(c.modifiedBy),
    modifiedDate: c.modifiedDate,
    isDeleted: c.isDeleted,
  };
}

export function toWorkItemView(raw: RawWorkItem, format: ContentFormat = "text"): WorkItemView {
  const f = raw.fields ?? {};
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (format === "text" && RICH_TEXT_FIELDS.has(key) && typeof value === "string") {
      fields[key] = htmlToText(value);
    } else if (key === "System.AssignedTo" || key === "System.CreatedBy" || key === "System.ChangedBy" || key === "System.AuthorizedAs") {
      fields[key] = toIdentity(value);
    } else {
      fields[key] = value;
    }
  }
  const conv = (v: unknown) => (typeof v === "string" ? (format === "text" ? htmlToText(v) : v) : undefined);
  const tagsRaw = str(f["System.Tags"]);
  const parent = f["System.Parent"];
  let parentId = typeof parent === "number" ? parent : undefined;
  if (parentId === undefined && raw.relations) {
    const p = raw.relations.find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");
    if (p) parentId = workItemIdFromUrl(p.url);
  }
  return {
    id: raw.id,
    rev: raw.rev,
    url: raw.url,
    webUrl: raw._links?.html?.href,
    project: str(f["System.TeamProject"]),
    type: str(f["System.WorkItemType"]),
    title: str(f["System.Title"]),
    state: str(f["System.State"]),
    reason: str(f["System.Reason"]),
    assignedTo: toIdentity(f["System.AssignedTo"]),
    areaPath: str(f["System.AreaPath"]),
    iterationPath: str(f["System.IterationPath"]),
    tags: tagsRaw ? tagsRaw.split(";").map((t) => t.trim()).filter(Boolean) : [],
    priority: typeof f["Microsoft.VSTS.Common.Priority"] === "number" ? (f["Microsoft.VSTS.Common.Priority"] as number) : undefined,
    createdBy: toIdentity(f["System.CreatedBy"]),
    createdDate: str(f["System.CreatedDate"]),
    changedBy: toIdentity(f["System.ChangedBy"]),
    changedDate: str(f["System.ChangedDate"]),
    parentId,
    content: {
      description: conv(f["System.Description"]),
      reproSteps: conv(f["Microsoft.VSTS.TCM.ReproSteps"]),
      acceptanceCriteria: conv(f["Microsoft.VSTS.Common.AcceptanceCriteria"]),
    },
    fields,
    relations: raw.relations?.map(toRelationView),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Read operations
 * ---------------------------------------------------------------------------------------------- */

export interface GetWorkItemOptions {
  project?: string | undefined;
  id: number;
  fields?: string[] | undefined;
  expand?: ExpandOption | undefined;
  asOf?: string | undefined;
}

export async function getWorkItemRaw(client: TfsClient, opts: GetWorkItemOptions): Promise<RawWorkItem> {
  const hasFields = !!opts.fields?.length;
  return client.get<RawWorkItem>({
    project: opts.project,
    path: `wit/workitems/${opts.id}`,
    query: {
      // `fields` and `$expand` are mutually exclusive in the API
      fields: hasFields ? opts.fields!.join(",") : undefined,
      $expand: hasFields ? undefined : opts.expand ?? "all",
      asOf: opts.asOf,
    },
  });
}

/** Resolve the project a work item belongs to (needed for project-scoped endpoints like comments). */
export async function resolveWorkItemProject(
  client: TfsClient,
  id: number,
  explicit: string | undefined
): Promise<string> {
  if (explicit) return explicit;
  const raw = await getWorkItemRaw(client, { id, fields: ["System.TeamProject"] });
  const project = raw.fields["System.TeamProject"];
  if (typeof project !== "string" || !project) {
    throw new Error(`Could not determine the project of work item ${id}; pass the \`project\` argument.`);
  }
  return project;
}

export interface GetCommentsOptions {
  project: string;
  id: number;
  top?: number | undefined;
  continuationToken?: string | undefined;
  order?: "asc" | "desc" | undefined;
  includeDeleted?: boolean | undefined;
}

export async function getCommentsRaw(client: TfsClient, opts: GetCommentsOptions): Promise<RawCommentList> {
  return client.get<RawCommentList>({
    project: opts.project,
    path: `wit/workItems/${opts.id}/comments`,
    apiVersion: COMMENTS_API_VERSION,
    query: {
      $top: opts.top,
      continuationToken: opts.continuationToken,
      order: opts.order,
      includeDeleted: opts.includeDeleted,
    },
  });
}

/** Fetch every page of comments for a work item. */
export async function getAllComments(client: TfsClient, project: string, id: number): Promise<RawComment[]> {
  const all: RawComment[] = [];
  let token: string | undefined;
  do {
    const page = await getCommentsRaw(client, { project, id, top: 200, continuationToken: token, order: "asc" });
    all.push(...(page.comments ?? []));
    token = page.continuationToken;
  } while (token);
  return all;
}

export interface BatchGetOptions {
  project?: string | undefined;
  ids: number[];
  fields?: string[] | undefined;
  expand?: ExpandOption | undefined;
  errorPolicy?: "omit" | "fail" | undefined;
  asOf?: string | undefined;
}

/** POST wit/workitemsbatch in chunks of 200 ids; returns raw work items in input order (missing ids omitted). */
export async function getWorkItemsBatchRaw(client: TfsClient, opts: BatchGetOptions): Promise<RawWorkItem[]> {
  const hasFields = !!opts.fields?.length;
  const out: RawWorkItem[] = [];
  for (const ids of chunk(opts.ids, WORKITEMS_BATCH_LIMIT)) {
    const body: Record<string, unknown> = {
      ids,
      errorPolicy: opts.errorPolicy === "fail" ? "Fail" : "Omit",
    };
    if (hasFields) body.fields = opts.fields;
    else body.$expand = opts.expand ?? "all";
    if (opts.asOf) body.asOf = opts.asOf;
    const res = await client.post<{ count: number; value: RawWorkItem[] }>({
      project: opts.project,
      path: "wit/workitemsbatch",
      body,
    });
    out.push(...(res.value ?? []));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Update operations
 * ---------------------------------------------------------------------------------------------- */

export interface JsonPatchOp {
  op: "add" | "replace" | "remove" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

export interface WorkItemUpdateSpec {
  state: string;
  /** Display name, `DOMAIN\user`, e-mail, or "" to unassign. */
  assignedTo: string;
  reason?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  areaPath?: string | undefined;
  iterationPath?: string | undefined;
  priority?: number | undefined;
  /** Arbitrary extra fields by reference name, e.g. { "Custom.Foo": "bar" }. `null` removes the field. */
  fields?: Record<string, unknown> | undefined;
  /** Text appended to the work item discussion (System.History). */
  comment?: string | undefined;
  /** Optimistic concurrency: fail if the item's revision differs. */
  expectedRev?: number | undefined;
}

/** Build the JSON Patch document for a work item update. */
export function buildPatchDocument(spec: WorkItemUpdateSpec): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  if (spec.expectedRev !== undefined) ops.push({ op: "test", path: "/rev", value: spec.expectedRev });

  const set = (field: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null || value === "") ops.push({ op: "remove", path: `/fields/${field}` });
    else ops.push({ op: "add", path: `/fields/${field}`, value });
  };

  ops.push({ op: "add", path: "/fields/System.State", value: spec.state });
  if (spec.reason !== undefined) set("System.Reason", spec.reason);
  // assignedTo is mandatory; "" means unassign
  if (spec.assignedTo.trim() === "") ops.push({ op: "remove", path: "/fields/System.AssignedTo" });
  else ops.push({ op: "add", path: "/fields/System.AssignedTo", value: spec.assignedTo });

  set("System.Title", spec.title);
  if (spec.description !== undefined) set("System.Description", spec.description === "" ? "" : textToHtml(spec.description));
  if (spec.tags !== undefined) set("System.Tags", spec.tags.length ? spec.tags.join("; ") : "");
  set("System.AreaPath", spec.areaPath);
  set("System.IterationPath", spec.iterationPath);
  set("Microsoft.VSTS.Common.Priority", spec.priority);

  for (const [field, value] of Object.entries(spec.fields ?? {})) {
    if (field === "System.State" || field === "System.AssignedTo") continue; // already handled
    set(field, value);
  }

  if (spec.comment) ops.push({ op: "add", path: "/fields/System.History", value: textToHtml(spec.comment) });
  return ops;
}

export interface UpdateWorkItemOptions {
  project?: string | undefined;
  id: number;
  patch: JsonPatchOp[];
  bypassRules?: boolean | undefined;
  validateOnly?: boolean | undefined;
  suppressNotifications?: boolean | undefined;
}

export function updateQuery(opts: Pick<UpdateWorkItemOptions, "bypassRules" | "validateOnly" | "suppressNotifications">) {
  return {
    bypassRules: opts.bypassRules ? true : undefined,
    validateOnly: opts.validateOnly ? true : undefined,
    suppressNotifications: opts.suppressNotifications ? true : undefined,
  };
}

export async function updateWorkItemRaw(client: TfsClient, opts: UpdateWorkItemOptions): Promise<RawWorkItem> {
  return client.jsonPatch<RawWorkItem>({
    project: opts.project,
    path: `wit/workitems/${opts.id}`,
    query: updateQuery(opts),
    body: opts.patch,
  });
}

export async function addCommentRaw(client: TfsClient, project: string, id: number, text: string): Promise<RawComment> {
  return client.post<RawComment>({
    project,
    path: `wit/workItems/${id}/comments`,
    apiVersion: COMMENTS_API_VERSION,
    body: { text: textToHtml(text) },
  });
}

export async function updateCommentRaw(
  client: TfsClient,
  project: string,
  id: number,
  commentId: number,
  text: string
): Promise<RawComment> {
  return client.patch<RawComment>({
    project,
    path: `wit/workItems/${id}/comments/${commentId}`,
    apiVersion: COMMENTS_API_VERSION,
    body: { text: textToHtml(text) },
  });
}

/* ------------------------------------------------------------------------------------------------
 * Queries / WIQL
 * ---------------------------------------------------------------------------------------------- */

export async function getQueryRaw(client: TfsClient, project: string, queryIdOrPath: string, depth = 0): Promise<RawQuery> {
  // Query can be addressed by GUID or by path ("Shared Queries/My Team/Open Bugs").
  const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queryIdOrPath);
  const segment = isGuid ? queryIdOrPath : queryIdOrPath.split("/").map(encodeURIComponent).join("/");
  return client.get<RawQuery>({
    project,
    path: `wit/queries/${segment}`,
    query: { $expand: "wiql", $depth: depth || undefined },
  });
}

export async function runQueryByIdRaw(client: TfsClient, project: string, queryId: string, top?: number): Promise<RawWiqlResult> {
  return client.get<RawWiqlResult>({
    project,
    path: `wit/wiql/${queryId}`,
    query: { $top: top },
  });
}

export async function runWiqlRaw(client: TfsClient, project: string | undefined, wiql: string, top?: number): Promise<RawWiqlResult> {
  return client.post<RawWiqlResult>({
    project,
    path: "wit/wiql",
    query: { $top: top },
    body: { query: wiql },
  });
}

/**
 * Inject an additional filter into a WIQL statement.
 * `extraWhere` is used as-is (e.g. `[System.State] = 'Active' AND [System.AssignedTo] = @Me`).
 */
export function injectExtraWhere(wiql: string, extraWhere: string): string {
  const filter = extraWhere.trim().replace(/^(AND|WHERE)\s+/i, "");
  if (!filter) return wiql;

  // Find the top-level WHERE / ORDER BY / ASOF / MODE keywords (outside of quotes/brackets).
  const upper = maskLiterals(wiql).toUpperCase();
  const whereIdx = indexOfKeyword(upper, "WHERE");
  const tailIdx = firstIndexOf(upper, ["ORDER BY", "ASOF", "MODE"], whereIdx >= 0 ? whereIdx : 0);
  const tail = tailIdx >= 0 ? wiql.slice(tailIdx) : "";
  const head = tailIdx >= 0 ? wiql.slice(0, tailIdx) : wiql;

  if (whereIdx < 0) {
    return `${head.trimEnd()} WHERE (${filter})${tail ? " " + tail.trimStart() : ""}`;
  }
  const beforeWhere = head.slice(0, whereIdx);
  const whereClause = head.slice(whereIdx + "WHERE".length).trim();
  return `${beforeWhere}WHERE (${whereClause}) AND (${filter})${tail ? " " + tail.trimStart() : ""}`;
}

function maskLiterals(s: string): string {
  // Replace contents of '...' and [...] with spaces so keyword search ignores them (keeps indices aligned).
  return s.replace(/'(?:[^']|'')*'|\[[^\]]*\]/g, (m) => " ".repeat(m.length));
}

function indexOfKeyword(upper: string, kw: string, from = 0): number {
  const re = new RegExp(`(^|[\\s)])${kw.replace(/\s+/g, "\\s+")}(?=[\\s(]|$)`, "g");
  re.lastIndex = from;
  const m = re.exec(upper);
  return m ? m.index + (m[1]?.length ?? 0) : -1;
}

function firstIndexOf(upper: string, kws: string[], from: number): number {
  let best = -1;
  for (const kw of kws) {
    const i = indexOfKeyword(upper, kw, from);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/** Extract unique work item ids from a WIQL result (flat or tree/oneHop). */
export function extractIds(result: RawWiqlResult): number[] {
  const ids = new Set<number>();
  for (const wi of result.workItems ?? []) ids.add(wi.id);
  for (const rel of result.workItemRelations ?? []) {
    if (rel.source?.id) ids.add(rel.source.id);
    if (rel.target?.id) ids.add(rel.target.id);
  }
  return Array.from(ids);
}
