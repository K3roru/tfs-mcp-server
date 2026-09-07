import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isTfsApiError, TfsApiError, type TfsClient } from "../client.js";
import { resolveProject } from "../config.js";
import type { ToolContext } from "../context.js";
import {
  baseName,
  decodeBytes,
  describeVersion,
  enrichNotFound,
  getItem,
  getItemBytes,
  getItemsBatch,
  listItems,
  listRepositories,
  looksBinary,
  normalizePath,
  toVersionSpec,
  type RawGitItem,
  type VersionSpec,
} from "../services/git.js";
import { addFailure, addSuccess, createBatchResult, mapWithConcurrency, uniq } from "../util/batch.js";
import { guard, ok } from "../util/result.js";

const projectArg = z
  .string()
  .min(1)
  .optional()
  .describe("Team project name or id that owns the repository. Overrides TFS_DEFAULT_PROJECT.");

const repositoryArg = z.string().min(1).describe("Repository name or id.");

const versionArgs = {
  branch: z.string().optional().describe("Branch name (e.g. 'develop'). Defaults to the repository's default branch."),
  commit: z.string().optional().describe("Commit SHA (alternative to branch)."),
  tag: z.string().optional().describe("Tag name (alternative to branch)."),
};

export interface FileContentView {
  path: string;
  repository: string;
  project: string;
  version: string;
  commitId: string | undefined;
  objectId: string;
  size: number | undefined;
  contentType: string | undefined;
  isBinary: boolean;
  encoding: "utf-8" | "base64";
  truncated: boolean;
  content: string;
  latestChange: { commitId: string | undefined; author: string | undefined; date: string | undefined; comment: string | undefined } | undefined;
  webUrl: string | undefined;
}

export interface DirectoryEntryView {
  path: string;
  name: string;
  isFolder: boolean;
  gitObjectType: string;
  objectId: string;
  commitId: string | undefined;
  contentType: string | undefined;
  isBinary: boolean | undefined;
  latestChange: { commitId: string | undefined; author: string | undefined; date: string | undefined; comment: string | undefined } | undefined;
  webUrl: string | undefined;
}

function latestChangeOf(item: RawGitItem) {
  const lc = item.latestProcessedChange;
  if (!lc) return undefined;
  return {
    commitId: lc.commitId,
    author: lc.author?.name ? (lc.author.email ? `${lc.author.name} <${lc.author.email}>` : lc.author.name) : undefined,
    date: lc.author?.date ?? lc.committer?.date,
    comment: lc.comment,
  };
}

export function toDirectoryEntry(item: RawGitItem): DirectoryEntryView {
  return {
    path: item.path,
    name: baseName(item.path),
    isFolder: item.isFolder ?? item.gitObjectType === "tree",
    gitObjectType: item.gitObjectType,
    objectId: item.objectId,
    commitId: item.commitId,
    contentType: item.contentMetadata?.contentType,
    isBinary: item.contentMetadata?.isBinary,
    latestChange: latestChangeOf(item),
    webUrl: item._links?.html?.href,
  };
}

/**
 * Fetch a single file's content and metadata. Text files come back inline from the JSON items call;
 * binaries (or files without inline content) are downloaded as bytes and returned base64-encoded.
 */
export async function fetchFile(
  client: TfsClient,
  args: { project: string; repository: string; path: string; version: VersionSpec | undefined; maxBytes: number | undefined; prefetched?: RawGitItem | undefined }
): Promise<FileContentView> {
  const itemArgs = { project: args.project, repository: args.repository, path: args.path, version: args.version };
  let meta: RawGitItem;
  try {
    meta = args.prefetched && args.prefetched.content !== undefined ? args.prefetched : await getItem(client, itemArgs, true);
  } catch (err) {
    return enrichNotFound(client, itemArgs, err);
  }
  if (meta.isFolder || meta.gitObjectType === "tree") {
    throw new Error(`'${normalizePath(args.path)}' is a directory, not a file. Use list_directory to browse it.`);
  }

  const metaIsBinary = meta.contentMetadata?.isBinary === true;
  let content: string;
  let encoding: "utf-8" | "base64";
  let isBinary: boolean;
  let size: number | undefined;
  let truncated = false;

  if (typeof meta.content === "string" && !metaIsBinary) {
    content = meta.content;
    encoding = "utf-8";
    isBinary = false;
    size = Buffer.byteLength(content, "utf8");
  } else {
    const bytes = await getItemBytes(client, itemArgs);
    size = bytes.byteLength;
    isBinary = metaIsBinary || looksBinary(bytes);
    if (isBinary) {
      encoding = "base64";
      content = Buffer.from(bytes).toString("base64");
    } else {
      encoding = "utf-8";
      content = decodeBytes(bytes, meta.contentMetadata?.encoding);
    }
  }

  if (args.maxBytes !== undefined && size !== undefined && size > args.maxBytes) {
    truncated = true;
    content = encoding === "base64" ? "" : content.slice(0, args.maxBytes);
  }

  return {
    path: normalizePath(meta.path ?? args.path),
    repository: args.repository,
    project: args.project,
    version: describeVersion(args.version),
    commitId: meta.commitId,
    objectId: meta.objectId,
    size,
    contentType: meta.contentMetadata?.contentType,
    isBinary,
    encoding,
    truncated,
    content,
    latestChange: latestChangeOf(meta),
    webUrl: meta._links?.html?.href,
  };
}

export function registerFileTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  /* ---------------------------------- list_repositories ---------------------------------- */
  server.registerTool(
    "list_repositories",
    {
      title: "List Git repositories",
      description: "List Git repositories in a project (or in the whole collection when no project is given), with default branch and URLs.",
      inputSchema: { project: projectArg.describe("Project to list; omit (and unset TFS_DEFAULT_PROJECT) to list every project's repositories.") },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async ({ project }) => {
      const proj = resolveProject(config, project);
      const repos = await listRepositories(client, proj);
      const data = {
        project: proj ?? "(all)",
        count: repos.length,
        repositories: repos
          .map((r) => ({
            id: r.id,
            name: r.name,
            project: r.project?.name,
            defaultBranch: r.defaultBranch?.replace(/^refs\/heads\//, ""),
            size: r.size,
            remoteUrl: r.remoteUrl,
            webUrl: r.webUrl,
            isDisabled: r.isDisabled,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      return ok(`${data.count} repositories in ${data.project}`, data);
    })
  );

  /* ---------------------------------- get_file_content ---------------------------------- */
  server.registerTool(
    "get_file_content",
    {
      title: "Get file content",
      description:
        "Read a file from a Git repository at a given branch/commit/tag (default: the repo's default branch). " +
        "Text files are returned inline; binaries as base64. If the file does not exist, the error explains whether the repository, " +
        "the branch or the directory is missing and lists the parent directory's entries.",
      inputSchema: {
        repository: repositoryArg,
        path: z.string().min(1).describe("Path inside the repository, e.g. '/src/app/main.ts'."),
        project: projectArg,
        ...versionArgs,
        maxBytes: z.number().int().positive().optional().describe("Truncate content beyond this many bytes (binaries are omitted entirely)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ repository, path, project, branch, commit, tag, maxBytes }) => {
        const proj = resolveProject(config, project, true);
        const version = toVersionSpec({ branch, commit, tag });
        const file = await fetchFile(client, { project: proj, repository, path, version, maxBytes });
        return ok(
          `${file.path} @ ${file.version} (${file.size ?? "?"} bytes, ${file.isBinary ? "binary/base64" : "text"}${file.truncated ? ", truncated" : ""})`,
          file
        );
      },
      ({ repository, path }) => `Failed to read '${path}' from repository '${repository}'`
    )
  );

  /* ---------------------------------- get_files_content (batch) ---------------------------------- */
  server.registerTool(
    "get_files_content",
    {
      title: "Get multiple files' content",
      description:
        "Read several files from one repository at the same branch/commit/tag in a single call. Existence and metadata are checked with one " +
        "itemsbatch request, then contents are fetched in parallel. Missing files are reported per path with the same verbose diagnostics as get_file_content.",
      inputSchema: {
        repository: repositoryArg,
        paths: z.array(z.string().min(1)).min(1).max(200).describe("File paths inside the repository."),
        project: projectArg,
        ...versionArgs,
        maxBytesPerFile: z.number().int().positive().optional().describe("Truncate each file beyond this many bytes."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ repository, paths, project, branch, commit, tag, maxBytesPerFile }) => {
        const proj = resolveProject(config, project, true);
        const version = toVersionSpec({ branch, commit, tag });
        const wanted = uniq(paths.map(normalizePath));
        const result = createBatchResult<string, FileContentView>();

        // Step 1: metadata for all paths in one request (best effort; some servers 404 the whole batch when a path is missing).
        const prefetched = new Map<string, RawGitItem>();
        const missing = new Set<string>();
        try {
          const batches = await getItemsBatch(client, proj, repository, wanted, version);
          batches.forEach((items, i) => {
            const p = wanted[i]!;
            const item = items.find((it) => normalizePath(it.path) === p) ?? items[0];
            if (item) prefetched.set(p, item);
            else missing.add(p);
          });
        } catch (err) {
          if (!(isTfsApiError(err) && (err.status === 404 || err.status === 400))) throw err;
          // fall through: resolve each file individually
        }

        // Step 2: fetch content with bounded concurrency; missing ones get diagnostics.
        const settled = await mapWithConcurrency(wanted, config.batchConcurrency, async (p) => {
          const itemArgs = { project: proj, repository, path: p, version };
          if (missing.has(p)) {
            const notFound = new TfsApiError({
              status: 404,
              url: client.buildUrl({ project: proj, path: `git/repositories/${encodeURIComponent(repository)}/items`, query: { path: p } }),
              message: `Item '${p}' was not returned by itemsbatch`,
              typeKey: "GitItemNotFoundException",
            });
            return enrichNotFound(client, itemArgs, notFound);
          }
          return fetchFile(client, { ...itemArgs, maxBytes: maxBytesPerFile, prefetched: prefetched.get(p) });
        });
        settled.forEach((s, i) => {
          if (s.status === "fulfilled") addSuccess(result, s.value);
          else addFailure(result, wanted[i]!, s.reason);
        });

        return ok(
          `Read ${result.summary.ok}/${result.summary.total} files from '${repository}' @ ${describeVersion(version)}` +
            (result.summary.failed ? `, ${result.summary.failed} failed` : ""),
          result
        );
      },
      ({ repository }) => `Failed to read files from repository '${repository}'`
    )
  );

  /* ---------------------------------- list_directory ---------------------------------- */
  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        "List files and folders under a directory path in a Git repository (one level or full recursion) with metadata: " +
        "object ids, content type, and the latest commit that touched each entry.",
      inputSchema: {
        repository: repositoryArg,
        path: z.string().default("/").describe("Directory path, e.g. '/src'. Defaults to the repository root."),
        project: projectArg,
        ...versionArgs,
        recursion: z.enum(["oneLevel", "full"]).default("oneLevel"),
        includeMetadata: z.boolean().default(true).describe("Include content metadata and latest change per entry (slower on large trees)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(
      async ({ repository, path, project, branch, commit, tag, recursion, includeMetadata }) => {
        const proj = resolveProject(config, project, true);
        const version = toVersionSpec({ branch, commit, tag });
        const dir = normalizePath(path);
        const itemArgs = { project: proj, repository, path: dir, version };
        let items: RawGitItem[];
        try {
          items = await listItems(client, { ...itemArgs, recursion, includeMetadata });
        } catch (err) {
          return enrichNotFound(client, itemArgs, err);
        }
        const self = items.find((it) => normalizePath(it.path) === dir);
        if (self && !(self.isFolder ?? self.gitObjectType === "tree")) {
          throw new Error(`'${dir}' is a file, not a directory. Use get_file_content to read it.`);
        }
        const entries = items.filter((it) => normalizePath(it.path) !== dir).map(toDirectoryEntry);
        entries.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.path.localeCompare(b.path));
        const data = {
          repository,
          project: proj,
          version: describeVersion(version),
          path: dir,
          commitId: self?.commitId,
          count: entries.length,
          folders: entries.filter((e) => e.isFolder).length,
          files: entries.filter((e) => !e.isFolder).length,
          entries,
        };
        return ok(`${data.count} entries under ${dir} (${data.folders} folders, ${data.files} files)`, data);
      },
      ({ repository, path }) => `Failed to list '${path}' in repository '${repository}'`
    )
  );
}
