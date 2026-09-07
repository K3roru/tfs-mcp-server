import type { TfsConfig } from "./config.js";

export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  /** HTTP method, default GET */
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * Project segment. `undefined` => collection-scoped URL ({base}/_apis/...).
   * A string => {base}/{project}/_apis/...
   */
  project?: string | undefined;
  /** Path after `_apis/`, e.g. "wit/workitems/123". Segments must already be URL-encoded. */
  path: string;
  /** Query string parameters; undefined/null values are skipped. */
  query?: Record<string, QueryValue>;
  /** Overrides the default api-version (e.g. "6.0-preview.3"). */
  apiVersion?: string;
  /** Request body; serialised as JSON unless it is a string. */
  body?: unknown;
  /** Content type for the body. */
  contentType?: "application/json" | "application/json-patch+json";
  /** Accept header, default application/json. */
  accept?: string;
  /** Per-request timeout in ms (default 60s). */
  timeoutMs?: number;
}

/** Structured error carrying everything the caller/LLM needs for a useful message. */
export class TfsApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly typeKey: string | undefined;
  readonly tfsMessage: string | undefined;
  readonly body: unknown;

  constructor(args: {
    status: number;
    url: string;
    message: string;
    typeKey?: string | undefined;
    tfsMessage?: string | undefined;
    body?: unknown;
  }) {
    super(args.message);
    this.name = "TfsApiError";
    this.status = args.status;
    this.url = args.url;
    this.typeKey = args.typeKey;
    this.tfsMessage = args.tfsMessage;
    this.body = args.body;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      status: this.status,
      typeKey: this.typeKey,
      message: this.tfsMessage ?? this.message,
      url: this.url,
    };
  }
}

interface TfsErrorBody {
  message?: string;
  typeKey?: string;
  typeName?: string;
  errorCode?: number;
  eventId?: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  contentType: string;
  bytes: Uint8Array;
  url: string;
}

/**
 * Minimal REST client for TFS / Azure DevOps Server.
 * Uses PAT via Basic auth (`:` + PAT), builds `{base}/{project}/_apis/{path}?api-version=...` URLs
 * and converts non-2xx responses into `TfsApiError`.
 */
export class TfsClient {
  readonly baseUrl: string;
  readonly apiVersion: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Pick<TfsConfig, "baseUrl" | "pat" | "apiVersion">, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiVersion = config.apiVersion;
    this.authHeader = "Basic " + Buffer.from(":" + config.pat, "utf8").toString("base64");
    this.fetchImpl = fetchImpl;
  }

  /** Build a fully-qualified request URL. */
  buildUrl(opts: Pick<RequestOptions, "project" | "path" | "query" | "apiVersion">): string {
    const segments = [this.baseUrl];
    if (opts.project) segments.push(encodeURIComponent(opts.project));
    segments.push("_apis", opts.path.replace(/^\/+/, ""));
    const url = new URL(segments.join("/"));
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("api-version", opts.apiVersion ?? this.apiVersion);
    return url.toString();
  }

  /** Relative URI (used for `$batch` sub-requests): "/{project}/_apis/{path}?...". */
  buildRelativeUri(opts: Pick<RequestOptions, "project" | "path" | "query" | "apiVersion">): string {
    const full = new URL(this.buildUrl(opts));
    const base = new URL(this.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    let path = full.pathname;
    if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length);
    return path + full.search;
  }

  /** Perform a request and return the raw response (throws TfsApiError on non-2xx). */
  async raw(opts: RequestOptions): Promise<RawResponse> {
    const url = this.buildUrl(opts);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: opts.accept ?? "application/json",
      // Some TFS versions redirect to an HTML sign-in page on auth failure instead of returning 401.
      "X-TFS-FedAuthRedirect": "Suppress",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "application/json";
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      const init: RequestInit = {
        method: opts.method ?? "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      };
      if (body !== undefined) init.body = body;
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new TfsApiError({
        status: 0,
        url,
        message: `Network error calling TFS: ${reason}`,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (response.status === 203 || (response.status >= 300 && response.status < 400)) {
      throw new TfsApiError({
        status: response.status,
        url,
        message:
          `TFS redirected the request (HTTP ${response.status}); this usually means the PAT is invalid/expired ` +
          `or TFS_BASE_URL does not point at a collection.`,
        typeKey: "AuthenticationRedirect",
      });
    }

    if (!response.ok) {
      const text = new TextDecoder().decode(bytes);
      let parsed: TfsErrorBody | undefined;
      if (contentType.includes("json")) {
        try {
          parsed = JSON.parse(text) as TfsErrorBody;
        } catch {
          /* ignore */
        }
      }
      const tfsMessage = parsed?.message;
      const generic =
        response.status === 401
          ? "Unauthorized: PAT rejected. Check TFS_PAT and its scopes."
          : response.status === 403
            ? "Forbidden: the PAT owner lacks permission for this resource."
            : response.status === 404
              ? "Not found."
              : `HTTP ${response.status} ${response.statusText}`;
      throw new TfsApiError({
        status: response.status,
        url,
        message: tfsMessage ? `${tfsMessage} (HTTP ${response.status})` : generic,
        typeKey: parsed?.typeKey,
        tfsMessage,
        body: parsed ?? (text.length < 2000 ? text : text.slice(0, 2000) + "…"),
      });
    }

    if (contentType.includes("text/html") && (opts.accept ?? "application/json").includes("json")) {
      throw new TfsApiError({
        status: response.status,
        url,
        message:
          "TFS returned an HTML page instead of JSON; this usually means authentication failed " +
          "(invalid PAT) or the URL is not a REST endpoint.",
        typeKey: "UnexpectedHtmlResponse",
      });
    }

    return { status: response.status, headers: response.headers, contentType, bytes, url };
  }

  /** Perform a request and parse JSON. */
  async json<T>(opts: RequestOptions): Promise<T> {
    const res = await this.raw(opts);
    if (res.bytes.byteLength === 0) return undefined as T;
    const text = new TextDecoder().decode(res.bytes);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TfsApiError({
        status: res.status,
        url: res.url,
        message: `Expected JSON from TFS but got ${res.contentType || "unknown content type"}`,
        typeKey: "InvalidJson",
        body: text.slice(0, 2000),
      });
    }
  }

  get<T>(opts: Omit<RequestOptions, "method" | "body">): Promise<T> {
    return this.json<T>({ ...opts, method: "GET" });
  }

  post<T>(opts: Omit<RequestOptions, "method">): Promise<T> {
    return this.json<T>({ ...opts, method: "POST" });
  }

  patch<T>(opts: Omit<RequestOptions, "method">): Promise<T> {
    return this.json<T>({ ...opts, method: "PATCH" });
  }

  /** JSON Patch request (work item updates). */
  jsonPatch<T>(opts: Omit<RequestOptions, "method" | "contentType">): Promise<T> {
    return this.json<T>({ ...opts, method: "PATCH", contentType: "application/json-patch+json" });
  }
}

/** Type guard. */
export function isTfsApiError(err: unknown): err is TfsApiError {
  return err instanceof TfsApiError;
}

/** Convert any error to a short human-readable line. */
export function describeError(err: unknown): string {
  if (isTfsApiError(err)) {
    const parts = [err.message];
    if (err.typeKey && !err.message.includes(err.typeKey)) parts.push(`[${err.typeKey}]`);
    parts.push(`URL: ${err.url}`);
    return parts.join(" ");
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
