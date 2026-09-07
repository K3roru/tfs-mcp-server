/**
 * Tiny route-based fetch mock. Routes are matched in order against `${METHOD} ${pathname+search}`
 * (relative to the collection URL) using a RegExp or exact string.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export type Route = {
  match: RegExp | string;
  method?: string;
  respond: MockResponse | ((req: RecordedRequest) => MockResponse);
};

export const BASE_URL = "https://tfs.example.com/tfs/DefaultCollection";

export function createMockFetch(routes: Route[]) {
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const rel = u.pathname.replace(new URL(BASE_URL).pathname, "") + u.search;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: RecordedRequest = { method, url, path: decodeURIComponent(rel), headers, body };
    requests.push(req);

    const route = routes.find((r) => {
      if (r.method && r.method.toUpperCase() !== method) return false;
      return typeof r.match === "string" ? req.path === r.match || rel === r.match : r.match.test(req.path) || r.match.test(rel);
    });
    if (!route) {
      return new Response(JSON.stringify({ message: `mock: no route for ${method} ${rel}`, typeKey: "MockNoRoute" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const res = typeof route.respond === "function" ? route.respond(req) : route.respond;
    const status = res.status ?? 200;
    const headersOut: Record<string, string> = { ...(res.headers ?? {}) };
    let payload: BodyInit | null = null;
    if (res.json !== undefined) {
      payload = JSON.stringify(res.json);
      headersOut["content-type"] ??= "application/json; charset=utf-8";
    } else if (res.text !== undefined) {
      payload = res.text;
      headersOut["content-type"] ??= "text/plain";
    } else if (res.bytes !== undefined) {
      payload = Buffer.from(res.bytes);
      headersOut["content-type"] ??= "application/octet-stream";
    }
    return new Response(status === 204 ? null : payload, { status, headers: headersOut });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

export function workItemFixture(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    rev: 3,
    url: `${BASE_URL}/_apis/wit/workItems/${id}`,
    fields: {
      "System.Id": id,
      "System.TeamProject": "Alpha",
      "System.WorkItemType": "Bug",
      "System.Title": `Bug ${id}`,
      "System.State": "Active",
      "System.Reason": "New",
      "System.AssignedTo": { displayName: "Jane Doe", uniqueName: "CORP\\jdoe", id: "u-1" },
      "System.AreaPath": "Alpha\\Team",
      "System.IterationPath": "Alpha\\Sprint 1",
      "System.Tags": "hotfix; backend",
      "System.CreatedBy": { displayName: "Bob", uniqueName: "CORP\\bob", id: "u-2" },
      "System.CreatedDate": "2026-01-01T00:00:00Z",
      "System.ChangedBy": { displayName: "Bob", uniqueName: "CORP\\bob", id: "u-2" },
      "System.ChangedDate": "2026-01-02T00:00:00Z",
      "System.Description": "<div>Line one<br>Line <b>two</b> &amp; three</div>",
      "Microsoft.VSTS.TCM.ReproSteps": "<ol><li>Open app</li><li>Click</li></ol>",
      ...overrides,
    },
    relations: [
      { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${BASE_URL}/_apis/wit/workItems/10`, attributes: { name: "Parent" } },
      { rel: "AttachedFile", url: `${BASE_URL}/_apis/wit/attachments/abc`, attributes: { name: "log.txt" } },
    ],
    _links: { html: { href: `https://tfs.example.com/tfs/DefaultCollection/Alpha/_workitems/edit/${id}` } },
  };
}
