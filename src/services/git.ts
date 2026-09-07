import { isTfsApiError, TfsApiError, type TfsClient } from "../client.js";

/* ------------------------------------------------------------------------------------------------
 * Raw TFS shapes
 * ---------------------------------------------------------------------------------------------- */

export interface RawRepository {
  id: string;
  name: string;
  url: string;
  project?: { id: string; name: string };
  defaultBranch?: string;
  size?: number;
  remoteUrl?: string;
  sshUrl?: string;
  webUrl?: string;
  isDisabled?: boolean;
  isFork?: boolean;
}

export interface GitUserDate {
  name?: string;
  email?: string;
  date?: string;
}

export interface RawGitItem {
  objectId: string;
  gitObjectType: "blob" | "tree" | "commit" | "tag" | string;
  commitId?: string;
  path: string;
  isFolder?: boolean;
  isSymLink?: boolean;
  url?: string;
  content?: string;
  contentMetadata?: {
    fileName?: string;
    extension?: string;
    contentType?: string;
    encoding?: number;
    isBinary?: boolean;
    isImage?: boolean;
    vsLink?: string;
  };
  latestProcessedChange?: {
    commitId?: string;
    author?: GitUserDate;
    committer?: GitUserDate;
    comment?: string;
    url?: string;
  };
  _links?: Record<string, { href: string }>;
}

export interface RawRef {
  name: string;
  objectId: string;
  creator?: { displayName?: string; uniqueName?: string };
  url?: string;
}

/* ------------------------------------------------------------------------------------------------
 * Version descriptor
 * ---------------------------------------------------------------------------------------------- */

export type VersionType = "branch" | "commit" | "tag";

export interface VersionSpec {
  version: string;
  versionType: VersionType;
}

/** Build a version descriptor from optional branch/commit/tag (exactly one, or none => default branch). */
export function toVersionSpec(args: { branch?: string | undefined; commit?: string | undefined; tag?: string | undefined }): VersionSpec | undefined {
  const given = [args.branch && "branch", args.commit && "commit", args.tag && "tag"].filter(Boolean);
  if (given.length > 1) throw new Error(`Specify only one of branch, commit or tag (got ${given.join(", ")}).`);
  if (args.branch) return { version: args.branch.replace(/^refs\/heads\//, ""), versionType: "branch" };
  if (args.commit) return { version: args.commit, versionType: "commit" };
  if (args.tag) return { version: args.tag.replace(/^refs\/tags\//, ""), versionType: "tag" };
  return undefined;
}

function versionQuery(v: VersionSpec | undefined): Record<string, string | undefined> {
  return {
    "versionDescriptor.version": v?.version,
    "versionDescriptor.versionType": v?.versionType,
  };
}

export function describeVersion(v: VersionSpec | undefined): string {
  return v ? `${v.versionType} '${v.version}'` : "the default branch";
}

export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "/") return "/";
  return (trimmed.startsWith("/") ? trimmed : "/" + trimmed).replace(/\/+$/, "");
}

export function parentPath(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function baseName(path: string): string {
  const p = normalizePath(path);
  return p.slice(p.lastIndexOf("/") + 1);
}

function repoSegment(repository: string): string {
  return encodeURIComponent(repository);
}

/* ------------------------------------------------------------------------------------------------
 * Repositories & refs
 * ---------------------------------------------------------------------------------------------- */

export async function listRepositories(client: TfsClient, project: string | undefined): Promise<RawRepository[]> {
  const res = await client.get<{ count: number; value: RawRepository[] }>({ project, path: "git/repositories" });
  return res.value ?? [];
}

export async function getRepository(client: TfsClient, project: string, repository: string): Promise<RawRepository> {
  return client.get<RawRepository>({ project, path: `git/repositories/${repoSegment(repository)}` });
}

export async function listRefs(client: TfsClient, project: string, repository: string, filter: string, top?: number): Promise<RawRef[]> {
  const res = await client.get<{ count: number; value: RawRef[] }>({
    project,
    path: `git/repositories/${repoSegment(repository)}/refs`,
    query: { filter, $top: top },
  });
  return res.value ?? [];
}

export async function branchExists(client: TfsClient, project: string, repository: string, branch: string): Promise<boolean> {
  const refs = await listRefs(client, project, repository, `heads/${branch}`);
  return refs.some((r) => r.name === `refs/heads/${branch}`);
}

/* ------------------------------------------------------------------------------------------------
 * Items
 * ---------------------------------------------------------------------------------------------- */

export interface ItemArgs {
  project: string;
  repository: string;
  path: string;
  version?: VersionSpec | undefined;
}

/** Metadata (+ inline text content when `includeContent`) for a single item. */
export async function getItem(client: TfsClient, args: ItemArgs, includeContent: boolean): Promise<RawGitItem> {
  return client.get<RawGitItem>({
    project: args.project,
    path: `git/repositories/${repoSegment(args.repository)}/items`,
    query: {
      path: normalizePath(args.path),
      ...versionQuery(args.version),
      includeContent: includeContent ? true : undefined,
      includeContentMetadata: true,
      latestProcessedChange: true,
      $format: "json",
    },
  });
}

/** Raw bytes of a file. */
export async function getItemBytes(client: TfsClient, args: ItemArgs): Promise<Uint8Array> {
  const res = await client.raw({
    project: args.project,
    path: `git/repositories/${repoSegment(args.repository)}/items`,
    query: {
      path: normalizePath(args.path),
      ...versionQuery(args.version),
      download: false,
      $format: "octetStream",
    },
    accept: "application/octet-stream",
  });
  return res.bytes;
}

export interface ListItemsArgs extends ItemArgs {
  recursion: "none" | "oneLevel" | "full";
  includeMetadata: boolean;
}

export async function listItems(client: TfsClient, args: ListItemsArgs): Promise<RawGitItem[]> {
  const res = await client.get<{ count: number; value: RawGitItem[] }>({
    project: args.project,
    path: `git/repositories/${repoSegment(args.repository)}/items`,
    query: {
      scopePath: normalizePath(args.path),
      recursionLevel: args.recursion === "full" ? "Full" : args.recursion === "oneLevel" ? "OneLevel" : "None",
      ...versionQuery(args.version),
      includeContentMetadata: args.includeMetadata ? true : undefined,
      latestProcessedChange: args.includeMetadata ? true : undefined,
    },
  });
  return res.value ?? [];
}

/** POST itemsbatch: metadata for many paths in one request. Returns one array per descriptor (may be empty when missing). */
export async function getItemsBatch(
  client: TfsClient,
  project: string,
  repository: string,
  paths: string[],
  version: VersionSpec | undefined
): Promise<RawGitItem[][]> {
  const res = await client.post<{ count: number; value: RawGitItem[][] }>({
    project,
    path: `git/repositories/${repoSegment(repository)}/itemsbatch`,
    body: {
      itemDescriptors: paths.map((p) => ({
        path: normalizePath(p),
        version: version?.version,
        versionType: version?.versionType,
        versionOptions: "none",
        recursionLevel: "none",
      })),
      includeContentMetadata: true,
      latestProcessedChange: false,
      includeLinks: false,
    },
  });
  return res.value ?? [];
}

/* ------------------------------------------------------------------------------------------------
 * Content decoding
 * ---------------------------------------------------------------------------------------------- */

const CODEPAGE_TO_ENCODING: Record<number, string> = {
  65001: "utf-8",
  1200: "utf-16le",
  1201: "utf-16be",
  1252: "windows-1252",
  1251: "windows-1251",
  28591: "iso-8859-1",
  20127: "ascii",
};

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function decodeBytes(bytes: Uint8Array, codePage: number | undefined): string {
  const enc = (codePage && CODEPAGE_TO_ENCODING[codePage]) || "utf-8";
  try {
    return new TextDecoder(enc, { ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Not-found diagnostics
 * ---------------------------------------------------------------------------------------------- */

export interface NotFoundDiagnostics {
  path: string;
  repository: string;
  project: string;
  version: string;
  repositoryExists: boolean | undefined;
  defaultBranch: string | undefined;
  branchExists: boolean | undefined;
  availableBranches: string[] | undefined;
  availableRepositories: string[] | undefined;
  parentDirectory: string;
  parentDirectoryExists: boolean | undefined;
  parentDirectoryEntries: string[] | undefined;
  suggestions: string[];
  originalError: string;
  message: string;
}

/**
 * Explain *why* an item could not be found: missing repo, missing branch, wrong directory or wrong file name.
 * Every probe is best-effort; failures are swallowed so the diagnostic itself never throws.
 */
export async function diagnoseNotFound(client: TfsClient, args: ItemArgs, original: unknown): Promise<NotFoundDiagnostics> {
  const path = normalizePath(args.path);
  const parent = parentPath(path);
  const name = baseName(path);
  const diag: NotFoundDiagnostics = {
    path,
    repository: args.repository,
    project: args.project,
    version: describeVersion(args.version),
    repositoryExists: undefined,
    defaultBranch: undefined,
    branchExists: undefined,
    availableBranches: undefined,
    availableRepositories: undefined,
    parentDirectory: parent,
    parentDirectoryExists: undefined,
    parentDirectoryEntries: undefined,
    suggestions: [],
    originalError: isTfsApiError(original) ? original.tfsMessage ?? original.message : String(original),
    message: "",
  };

  // 1) repository
  try {
    const repo = await getRepository(client, args.project, args.repository);
    diag.repositoryExists = true;
    diag.defaultBranch = repo.defaultBranch?.replace(/^refs\/heads\//, "");
  } catch (err) {
    if (isTfsApiError(err) && err.status === 404) {
      diag.repositoryExists = false;
      try {
        diag.availableRepositories = (await listRepositories(client, args.project)).map((r) => r.name).sort();
      } catch {
        /* ignore */
      }
      diag.message =
        `Repository '${args.repository}' does not exist in project '${args.project}'.` +
        (diag.availableRepositories ? ` Available repositories: ${diag.availableRepositories.join(", ") || "(none)"}.` : "");
      return diag;
    }
  }

  // 2) branch
  if (args.version?.versionType === "branch") {
    try {
      diag.branchExists = await branchExists(client, args.project, args.repository, args.version.version);
      if (!diag.branchExists) {
        const refs = await listRefs(client, args.project, args.repository, "heads/", 50);
        diag.availableBranches = refs.map((r) => r.name.replace(/^refs\/heads\//, "")).sort();
        const lower = args.version.version.toLowerCase();
        diag.suggestions.push(
          ...diag.availableBranches.filter((b) => b.toLowerCase() === lower || b.toLowerCase().includes(lower)).map((b) => `branch '${b}'`)
        );
        diag.message =
          `Branch '${args.version.version}' does not exist in repository '${args.repository}' (project '${args.project}'). ` +
          `Default branch: ${diag.defaultBranch ?? "unknown"}. ` +
          `Branches (up to 50): ${diag.availableBranches.join(", ") || "(none)"}.`;
        return diag;
      }
    } catch {
      /* ignore */
    }
  }

  // 3) parent directory
  try {
    const entries = await listItems(client, {
      project: args.project,
      repository: args.repository,
      path: parent,
      version: args.version,
      recursion: "oneLevel",
      includeMetadata: false,
    });
    diag.parentDirectoryExists = true;
    diag.parentDirectoryEntries = entries
      .filter((e) => normalizePath(e.path) !== parent)
      .map((e) => baseName(e.path) + (e.isFolder || e.gitObjectType === "tree" ? "/" : ""))
      .sort();
    const lower = name.toLowerCase();
    const stem = lower.replace(/\.[^.]+$/, "");
    for (const entry of diag.parentDirectoryEntries) {
      const el = entry.replace(/\/$/, "").toLowerCase();
      if (el === lower) diag.suggestions.push(`'${parent === "/" ? "" : parent}/${entry}' (case differs)`);
      else if (stem && (el.startsWith(stem) || el.includes(lower))) diag.suggestions.push(`'${parent === "/" ? "" : parent}/${entry}'`);
    }
  } catch (err) {
    if (isTfsApiError(err) && err.status === 404) diag.parentDirectoryExists = false;
  }

  const where = `in repository '${args.repository}' (project '${args.project}') at ${diag.version}`;
  if (diag.parentDirectoryExists === false) {
    diag.message = `Path '${path}' not found ${where}: the parent directory '${parent}' does not exist either.`;
  } else if (diag.parentDirectoryExists) {
    diag.message =
      `File '${path}' not found ${where}. The directory '${parent}' exists and contains: ` +
      `${diag.parentDirectoryEntries?.join(", ") || "(empty)"}.` +
      (diag.suggestions.length ? ` Did you mean ${diag.suggestions.join(" or ")}?` : "");
  } else {
    diag.message = `Path '${path}' not found ${where}. ${diag.originalError}`;
  }
  return diag;
}

/** Convert a not-found TfsApiError into a richer TfsApiError with diagnostics attached. */
export async function enrichNotFound(client: TfsClient, args: ItemArgs, err: unknown): Promise<never> {
  if (isTfsApiError(err) && err.status === 404) {
    const diag = await diagnoseNotFound(client, args, err);
    throw new TfsApiError({
      status: 404,
      url: err.url,
      message: diag.message,
      typeKey: err.typeKey ?? "GitItemNotFoundException",
      tfsMessage: diag.message,
      body: diag,
    });
  }
  throw err;
}
