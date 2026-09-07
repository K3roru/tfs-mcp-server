import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isTfsApiError, TfsApiError } from "../client.js";
import { resolveProject } from "../config.js";
import type { ToolContext } from "../context.js";
import {
  addCommentRaw,
  buildPatchDocument,
  extractIds,
  getAllComments,
  getCommentsRaw,
  getQueryRaw,
  getWorkItemRaw,
  getWorkItemsBatchRaw,
  injectExtraWhere,
  resolveWorkItemProject,
  runQueryByIdRaw,
  runWiqlRaw,
  toCommentView,
  toWorkItemView,
  updateCommentRaw,
  updateQuery,
  updateWorkItemRaw,
  type ContentFormat,
  type JsonPatchOp,
  type RawComment,
  type RawWiqlResult,
  type RawWorkItem,
  type WorkItemView,
} from "../services/workitems.js";
import { addFailure, addSuccess, chunk, createBatchResult, mapWithConcurrency, uniq } from "../util/batch.js";
import { guard, ok } from "../util/result.js";

/* ------------------------------------------------------------------------------------------------
 * Shared schema fragments
 * ---------------------------------------------------------------------------------------------- */

const projectArg = z
  .string()
  .min(1)
  .optional()
  .describe("Team project name or id. Overrides TFS_DEFAULT_PROJECT. Work items and repos may live in different projects.");

const formatArg = z
  .enum(["text", "html"])
  .default("text")
  .describe("How to return rich-text fields (Description, Repro Steps, comments): converted to plain text/markdown, or raw HTML.");

const fieldsArg = z
  .array(z.string().min(1))
  .optional()
  .describe(
    "Restrict returned fields to these reference names (e.g. System.Title, System.State). When omitted, all fields plus relations are returned."
  );

const expandArg = z
  .enum(["none", "relations", "fields", "links", "all"])
  .default("all")
  .describe("Which extra data to expand when `fields` is not given.");

const updateFieldsShape = {
  state: z.string().min(1).describe("New System.State value (e.g. 'Active', 'Resolved', 'Closed'). Required."),
  assignedTo: z
    .string()
    .describe(
      "New System.AssignedTo value: display name, 'DOMAIN\\\\user', e-mail, or 'Display Name <DOMAIN\\\\user>'. Use an empty string to unassign. Required. " +
        "Use get_current_identity to obtain a value for the PAT owner."
    ),
  reason: z.string().optional().describe("System.Reason (some state transitions require a specific reason)."),
  title: z.string().optional(),
  description: z.string().optional().describe("System.Description; plain text is converted to HTML."),
  tags: z.array(z.string()).optional().describe("Replaces System.Tags. Empty array clears tags."),
  areaPath: z.string().optional(),
  iterationPath: z.string().optional(),
  priority: z.number().int().optional().describe("Microsoft.VSTS.Common.Priority"),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional fields by reference name, e.g. {\"Microsoft.VSTS.Scheduling.RemainingWork\": 4}. Use null to clear a field."),
  comment: z.string().optional().describe("Discussion comment added together with the update (System.History)."),
  bypassRules: z.boolean().optional().describe("Bypass work item type rules (requires project collection admin rights)."),
  validateOnly: z.boolean().optional().describe("Validate the update without saving."),
  suppressNotifications: z.boolean().optional().describe("Do not fire notifications for this update."),
};

interface ParsedBatchBody {
  code: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function parseBatchBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Registration
 * ---------------------------------------------------------------------------------------------- */

export function registerWorkItemTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  const attachComments = async (view: WorkItemView, format: ContentFormat, project: string | undefined) => {
    const proj = project ?? view.project;
    if (!proj) return view;
    const comments = await getAllComments(client, proj, view.id);
    view.comments = comments.map((c) => toCommentView(c, format));
    return view;
  };

  /* ---------------------------------- get_work_item ---------------------------------- */
  server.registerTool(
    "get_work_item",
    {
      title: "Get work item",
      description:
        "Get a single work item: metadata (type, title, state, assignee, area/iteration, tags, dates), rich-text content " +
        "(description, repro steps, acceptance criteria), relations (parent/children/links) and optionally its comments.",
      inputSchema: {
        id: z.number().int().positive().describe("Work item id"),
        project: projectArg,
        fields: fieldsArg,
        expand: expandArg,
        includeComments: z.boolean().default(false).describe("Also fetch the discussion comments."),
        format: formatArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ id, project, fields, expand, includeComments, format }) => {
        const proj = resolveProject(config, project);
        const raw = await getWorkItemRaw(client, { project: proj, id, fields, expand });
        const view = toWorkItemView(raw, format);
        if (includeComments) await attachComments(view, format, proj);
        return ok(
          `Work item #${view.id}${view.type ? ` [${view.type}]` : ""} "${view.title ?? ""}" — ${view.state ?? "?"}, assigned to ${view.assignedTo?.displayName ?? "nobody"}`,
          view
        );
      },
      ({ id }) => `Failed to get work item ${id}`
    )
  );

  /* ---------------------------------- get_work_items (batch) ---------------------------------- */
  server.registerTool(
    "get_work_items",
    {
      title: "Get multiple work items",
      description:
        "Read many work items in one call (uses the workitemsbatch API, chunked by 200 ids). Missing ids are reported in `failed` " +
        "instead of failing the whole request (errorPolicy=omit).",
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(2000).describe("Work item ids"),
        project: projectArg,
        fields: fieldsArg,
        expand: expandArg,
        includeComments: z.boolean().default(false).describe("Also fetch comments for every item (one extra request per item)."),
        format: formatArg,
        errorPolicy: z.enum(["omit", "fail"]).default("omit").describe("omit: skip missing ids; fail: whole call fails if any id is missing."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async ({ ids, project, fields, expand, includeComments, format, errorPolicy }) => {
      const proj = resolveProject(config, project);
      const wanted = uniq(ids);
      const result = createBatchResult<number, WorkItemView>();
      const rawItems = await getWorkItemsBatchRaw(client, { project: proj, ids: wanted, fields, expand, errorPolicy });
      const byId = new Map(rawItems.map((w) => [w.id, w]));
      const views: WorkItemView[] = [];
      for (const id of wanted) {
        const raw = byId.get(id);
        if (raw) views.push(toWorkItemView(raw, format));
        else addFailure(result, id, `Work item ${id} not found or not accessible`, 404);
      }
      if (includeComments) {
        const settled = await mapWithConcurrency(views, config.batchConcurrency, (v) => attachComments(v, format, proj));
        settled.forEach((s, i) => {
          if (s.status === "rejected") {
            const v = views[i]!;
            v.comments = undefined;
            (v as WorkItemView & { commentsError?: string }).commentsError = String(
              isTfsApiError(s.reason) ? s.reason.message : s.reason
            );
          }
        });
      }
      for (const v of views) addSuccess(result, v);
      return ok(`Fetched ${result.summary.ok}/${result.summary.total} work items` + (result.summary.failed ? `, ${result.summary.failed} missing` : ""), result);
    })
  );

  /* ---------------------------------- get_work_item_comments ---------------------------------- */
  server.registerTool(
    "get_work_item_comments",
    {
      title: "Get work item comments",
      description: "List discussion comments of a work item (paged). Returns comment ids needed for update_work_item_comment.",
      inputSchema: {
        id: z.number().int().positive().describe("Work item id"),
        project: projectArg,
        top: z.number().int().min(1).max(200).optional().describe("Page size (default: server default, max 200)."),
        continuationToken: z.string().optional().describe("Token from a previous page."),
        order: z.enum(["asc", "desc"]).default("asc"),
        includeDeleted: z.boolean().default(false),
        format: formatArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ id, project, top, continuationToken, order, includeDeleted, format }) => {
        const proj = await resolveWorkItemProject(client, id, resolveProject(config, project));
        const page = await getCommentsRaw(client, { project: proj, id, top, continuationToken, order, includeDeleted });
        const data = {
          workItemId: id,
          project: proj,
          totalCount: page.totalCount,
          count: page.count,
          continuationToken: page.continuationToken,
          comments: (page.comments ?? []).map((c) => toCommentView(c, format)),
        };
        return ok(`${data.count} of ${data.totalCount} comments for work item #${id}`, data);
      },
      ({ id }) => `Failed to get comments of work item ${id}`
    )
  );

  /* ---------------------------------- update_work_item ---------------------------------- */
  server.registerTool(
    "update_work_item",
    {
      title: "Update work item",
      description:
        "Update a work item's metadata via JSON Patch. `state` and `assignedTo` are mandatory; other fields are optional. " +
        "Returns the updated work item.",
      inputSchema: {
        id: z.number().int().positive().describe("Work item id"),
        project: projectArg,
        expectedRev: z.number().int().optional().describe("Optimistic concurrency: fail if the current revision differs."),
        ...updateFieldsShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard(
      async ({ id, project, bypassRules, validateOnly, suppressNotifications, ...spec }) => {
        const proj = resolveProject(config, project);
        const patch = buildPatchDocument(spec);
        const raw = await updateWorkItemRaw(client, { project: proj, id, patch, bypassRules, validateOnly, suppressNotifications });
        const view = toWorkItemView(raw, "text");
        return ok(
          `${validateOnly ? "Validated" : "Updated"} work item #${view.id}: state=${view.state}, assignedTo=${view.assignedTo?.displayName ?? "unassigned"} (rev ${view.rev})`,
          { workItem: view, appliedPatch: patch }
        );
      },
      ({ id }) => `Failed to update work item ${id}`
    )
  );

  /* ---------------------------------- update_work_items (batch) ---------------------------------- */
  server.registerTool(
    "update_work_items",
    {
      title: "Update multiple work items",
      description:
        "Apply the same update (state + assignedTo, optionally more fields/comment) to many work items. Uses the wit/$batch endpoint " +
        "(one HTTP request per 200 items) and falls back to parallel single PATCH calls if $batch is unavailable. Per-item results are reported.",
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(1000).describe("Work item ids"),
        project: projectArg,
        ...updateFieldsShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard(async ({ ids, project, bypassRules, validateOnly, suppressNotifications, ...spec }) => {
      const proj = resolveProject(config, project);
      const patch = buildPatchDocument(spec);
      const wanted = uniq(ids);
      const result = createBatchResult<number, { id: number; rev: number; state: string | undefined; assignedTo: string | undefined; title: string | undefined }>();
      const summarize = (raw: RawWorkItem) => {
        const v = toWorkItemView(raw, "html");
        return { id: v.id, rev: v.rev, state: v.state, assignedTo: v.assignedTo?.displayName, title: v.title };
      };

      const fallbackSingle = async (batchIds: number[]) => {
        const settled = await mapWithConcurrency(batchIds, config.batchConcurrency, (id) =>
          updateWorkItemRaw(client, { project: proj, id, patch, bypassRules, validateOnly, suppressNotifications })
        );
        settled.forEach((s, i) => {
          if (s.status === "fulfilled") addSuccess(result, summarize(s.value));
          else addFailure(result, batchIds[i]!, s.reason);
        });
      };

      let usedBatchEndpoint = true;
      for (const batchIds of chunk(wanted, 200)) {
        const q = updateQuery({ bypassRules, validateOnly, suppressNotifications });
        const requests = batchIds.map((id) => ({
          method: "PATCH",
          uri: client.buildRelativeUri({ project: proj, path: `wit/workItems/${id}`, query: q }),
          headers: { "Content-Type": "application/json-patch+json" },
          body: patch,
        }));
        let response: { count?: number; value?: ParsedBatchBody[] } | ParsedBatchBody[];
        try {
          response = await client.post({ path: "wit/$batch", body: requests });
        } catch (err) {
          if (isTfsApiError(err) && (err.status === 404 || err.status === 405 || err.status === 400)) {
            usedBatchEndpoint = false;
            await fallbackSingle(batchIds);
            continue;
          }
          throw err;
        }
        const values = Array.isArray(response) ? response : response.value ?? [];
        if (values.length !== batchIds.length) {
          // Unexpected shape — be safe and fall back.
          usedBatchEndpoint = false;
          await fallbackSingle(batchIds);
          continue;
        }
        values.forEach((entry, i) => {
          const id = batchIds[i]!;
          const body = parseBatchBody(entry.body);
          if (entry.code >= 200 && entry.code < 300 && body && typeof body === "object") {
            addSuccess(result, summarize(body as RawWorkItem));
          } else {
            const msg = (body as { message?: string } | undefined)?.message ?? `HTTP ${entry.code}`;
            addFailure(result, id, new TfsApiError({ status: entry.code, url: requests[i]!.uri, message: msg, tfsMessage: msg }));
          }
        });
      }
      return ok(
        `${validateOnly ? "Validated" : "Updated"} ${result.summary.ok}/${result.summary.total} work items` +
          (result.summary.failed ? `, ${result.summary.failed} failed` : "") +
          (usedBatchEndpoint ? "" : " (used per-item fallback)"),
        { ...result, appliedPatch: patch, usedBatchEndpoint }
      );
    })
  );

  /* ---------------------------------- add_work_item_comment ---------------------------------- */
  server.registerTool(
    "add_work_item_comment",
    {
      title: "Add work item comment",
      description: "Add a discussion comment to a work item. Plain text is converted to HTML; HTML is accepted as-is. Returns the new comment id.",
      inputSchema: {
        id: z.number().int().positive().describe("Work item id"),
        project: projectArg,
        text: z.string().min(1).describe("Comment text (plain text or HTML)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(
      async ({ id, project, text }) => {
        const proj = await resolveWorkItemProject(client, id, resolveProject(config, project));
        const raw = await addCommentRaw(client, proj, id, text);
        const view = toCommentView(raw, "text");
        return ok(`Added comment #${view.id} to work item #${id}`, view);
      },
      ({ id }) => `Failed to add comment to work item ${id}`
    )
  );

  /* ---------------------------------- add_comment_to_work_items (batch) ---------------------------------- */
  server.registerTool(
    "add_comment_to_work_items",
    {
      title: "Add the same comment to multiple work items",
      description:
        "Add one comment text to many work items. The comments API has no batch endpoint, so requests are fanned out with bounded concurrency; " +
        "per-item results (comment ids / errors) are reported.",
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(500).describe("Work item ids"),
        project: projectArg,
        text: z.string().min(1).describe("Comment text (plain text or HTML)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(async ({ ids, project, text }) => {
      const explicit = resolveProject(config, project);
      const wanted = uniq(ids);
      const result = createBatchResult<number, { workItemId: number; commentId: number; createdDate: string | undefined }>();
      const settled = await mapWithConcurrency(wanted, config.batchConcurrency, async (id) => {
        const proj = await resolveWorkItemProject(client, id, explicit);
        const raw: RawComment = await addCommentRaw(client, proj, id, text);
        return { workItemId: id, commentId: raw.id, createdDate: raw.createdDate };
      });
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") addSuccess(result, s.value);
        else addFailure(result, wanted[i]!, s.reason);
      });
      return ok(`Commented on ${result.summary.ok}/${result.summary.total} work items` + (result.summary.failed ? `, ${result.summary.failed} failed` : ""), result);
    })
  );

  /* ---------------------------------- update_work_item_comment ---------------------------------- */
  server.registerTool(
    "update_work_item_comment",
    {
      title: "Update work item comment",
      description: "Replace the text of an existing comment (use get_work_item_comments to find comment ids).",
      inputSchema: {
        id: z.number().int().positive().describe("Work item id"),
        commentId: z.number().int().positive().describe("Comment id"),
        project: projectArg,
        text: z.string().min(1).describe("New comment text (plain text or HTML)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard(
      async ({ id, commentId, project, text }) => {
        const proj = await resolveWorkItemProject(client, id, resolveProject(config, project));
        const raw = await updateCommentRaw(client, proj, id, commentId, text);
        const view = toCommentView(raw, "text");
        return ok(`Updated comment #${commentId} on work item #${id} (version ${view.version})`, view);
      },
      ({ id, commentId }) => `Failed to update comment ${commentId} of work item ${id}`
    )
  );

  /* ---------------------------------- get_query ---------------------------------- */
  server.registerTool(
    "get_query",
    {
      title: "Get saved query",
      description:
        "Read a saved work item query by GUID or path (e.g. 'Shared Queries/Team/Open Bugs'): name, path, type, columns and WIQL text. " +
        "For folders, children are listed (depth 1).",
      inputSchema: {
        queryId: z.string().min(1).describe("Query GUID or full path."),
        project: projectArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ queryId, project }) => {
        const proj = resolveProject(config, project, true);
        const raw = await getQueryRaw(client, proj, queryId, 1);
        const data = {
          id: raw.id,
          name: raw.name,
          path: raw.path,
          isFolder: raw.isFolder ?? false,
          isPublic: raw.isPublic,
          queryType: raw.queryType,
          wiql: raw.wiql,
          columns: raw.columns?.map((c) => c.referenceName),
          sortColumns: raw.sortColumns?.map((s) => ({ field: s.field.referenceName, descending: s.descending })),
          lastModifiedDate: raw.lastModifiedDate,
          webUrl: raw._links?.html?.href,
          children: raw.children?.map((c) => ({ id: c.id, name: c.name, path: c.path, isFolder: c.isFolder ?? false, queryType: c.queryType })),
        };
        return ok(`Query "${data.path}" (${data.isFolder ? "folder" : data.queryType})`, data);
      },
      ({ queryId }) => `Failed to read query ${queryId}`
    )
  );

  /* ---------------------------------- shared: materialise a WIQL result ---------------------------------- */
  const materialise = async (
    result: RawWiqlResult,
    project: string | undefined,
    fields: string[] | undefined,
    format: ContentFormat,
    top: number | undefined
  ) => {
    let ids = extractIds(result);
    const truncated = top !== undefined && ids.length > top;
    if (truncated) ids = ids.slice(0, top);
    const effectiveFields =
      fields && fields.length ? fields : result.columns?.map((c) => c.referenceName).filter((n) => n !== "System.Id");
    const rawItems = ids.length
      ? await getWorkItemsBatchRaw(client, { project, ids, fields: effectiveFields, errorPolicy: "omit" })
      : [];
    const byId = new Map(rawItems.map((w) => [w.id, w]));
    const items = ids.map((id) => byId.get(id)).filter((w): w is RawWorkItem => !!w).map((w) => toWorkItemView(w, format));
    return {
      queryType: result.queryType,
      asOf: result.asOf,
      columns: result.columns?.map((c) => c.referenceName),
      totalMatches: extractIds(result).length,
      returned: items.length,
      truncated,
      ids,
      relations: result.workItemRelations?.map((r) => ({ rel: r.rel ?? null, source: r.source?.id ?? null, target: r.target.id })),
      workItems: items,
    };
  };

  /* ---------------------------------- run_query ---------------------------------- */
  server.registerTool(
    "run_query",
    {
      title: "Run saved query",
      description:
        "Execute a saved query by GUID or path and return the matching work items. Optionally append a custom WIQL filter " +
        "(`extraWhere`, passed as-is and AND-ed with the query's WHERE clause), e.g. \"[System.State] = 'Active' AND [System.Tags] CONTAINS 'hotfix'\".",
      inputSchema: {
        queryId: z.string().min(1).describe("Query GUID or full path."),
        project: projectArg,
        extraWhere: z.string().optional().describe("Additional WIQL condition, AND-ed with the saved query's WHERE clause."),
        top: z.number().int().min(1).max(2000).default(200).describe("Max number of work items to materialise."),
        fields: fieldsArg.describe("Fields to return per work item. Defaults to the query's columns."),
        format: formatArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ queryId, project, extraWhere, top, fields, format }) => {
        const proj = resolveProject(config, project, true);
        let result: RawWiqlResult;
        let effectiveWiql: string | undefined;
        if (extraWhere?.trim()) {
          const q = await getQueryRaw(client, proj, queryId);
          if (!q.wiql) throw new Error(`Query "${queryId}" has no WIQL (is it a folder?)`);
          effectiveWiql = injectExtraWhere(q.wiql, extraWhere);
          result = await runWiqlRaw(client, proj, effectiveWiql, top);
        } else {
          const isGuid = /^[0-9a-f-]{36}$/i.test(queryId);
          const id = isGuid ? queryId : (await getQueryRaw(client, proj, queryId)).id;
          result = await runQueryByIdRaw(client, proj, id, top);
        }
        const data = { queryId, wiql: effectiveWiql, ...(await materialise(result, proj, fields, format, top)) };
        return ok(`Query returned ${data.totalMatches} work items (${data.returned} materialised)`, data);
      },
      ({ queryId }) => `Failed to run query ${queryId}`
    )
  );

  /* ---------------------------------- run_wiql ---------------------------------- */
  server.registerTool(
    "run_wiql",
    {
      title: "Run WIQL",
      description:
        "Execute an arbitrary WIQL query string as-is, e.g. \"SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] = 'Active'\". " +
        "Returns the matching work items (flat) or the link tree (tree/oneHop queries).",
      inputSchema: {
        wiql: z.string().min(1).describe("Full WIQL statement."),
        project: projectArg.describe("Project used to resolve @project; optional for collection-wide queries."),
        top: z.number().int().min(1).max(2000).default(200).describe("Max number of work items to materialise."),
        fields: fieldsArg.describe("Fields to return per work item. Defaults to the SELECT columns."),
        format: formatArg,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ wiql, project, top, fields, format }) => {
        const proj = resolveProject(config, project);
        const result = await runWiqlRaw(client, proj, wiql, top);
        const data = { wiql, ...(await materialise(result, proj, fields, format, top)) };
        return ok(`WIQL returned ${data.totalMatches} work items (${data.returned} materialised)`, data);
      },
      () => "Failed to run WIQL"
    )
  );
}

export type { JsonPatchOp };
