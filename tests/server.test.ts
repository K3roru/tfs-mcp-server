import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TfsConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { BASE_URL, createMockFetch, workItemFixture, type RecordedRequest, type Route } from "./helpers/mockFetch.js";

const config: TfsConfig = { baseUrl: BASE_URL, pat: "pat", defaultProject: "Alpha", apiVersion: "6.0", batchConcurrency: 3 };

async function setup(routes: Route[], cfg: TfsConfig = config) {
  const { fetchImpl, requests } = createMockFetch(routes);
  const server = createServer(cfg, fetchImpl);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, server, requests, call, close: () => Promise.all([client.close(), server.close()]) };
}

const structured = <T = Record<string, unknown>>(r: CallToolResult) => r.structuredContent as T;
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("MCP server", () => {
  let ctx: Awaited<ReturnType<typeof setup>> | undefined;
  beforeEach(() => (ctx = undefined));
  afterEach(async () => ctx?.close());

  it("exposes all planned tools", async () => {
    ctx = await setup([]);
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_comment_to_work_items",
        "add_work_item_comment",
        "get_current_identity",
        "get_file_content",
        "get_files_content",
        "get_query",
        "get_work_item",
        "get_work_item_comments",
        "get_work_items",
        "list_directory",
        "list_repositories",
        "run_query",
        "run_wiql",
        "search_identities",
        "update_work_item",
        "update_work_item_comment",
        "update_work_items",
      ].sort()
    );
  });

  /* ------------------------------------------------------------------ work items */

  it("get_work_item returns metadata, content and comments; honours project override", async () => {
    ctx = await setup([
      { match: /^\/Beta\/_apis\/wit\/workitems\/42\?/, respond: { json: workItemFixture(42, { "System.TeamProject": "Beta" }) } },
      {
        match: /^\/Beta\/_apis\/wit\/workItems\/42\/comments\?/,
        respond: {
          json: {
            totalCount: 1,
            count: 1,
            comments: [{ id: 7, workItemId: 42, version: 1, text: "<div>Hi <b>there</b></div>", createdBy: { displayName: "Bob" }, createdDate: "2026-01-03T00:00:00Z" }],
          },
        },
      },
    ]);
    const res = await ctx.call("get_work_item", { id: 42, project: "Beta", includeComments: true });
    expect(res.isError).toBeFalsy();
    const wi = structured(res);
    expect(wi.id).toBe(42);
    expect(wi.state).toBe("Active");
    expect((wi.content as { description: string }).description).toBe("Line one\nLine **two** & three");
    expect((wi.comments as { text: string }[])[0]!.text).toBe("Hi **there**");
    expect(ctx.requests[0]!.path).toContain("/Beta/_apis/wit/workitems/42");
    expect(ctx.requests[0]!.path).toContain("$expand=all");
    expect(ctx.requests[1]!.path).toContain("api-version=6.0-preview.3");
  });

  it("get_work_item reports TFS errors as tool errors", async () => {
    ctx = await setup([{ match: /workitems\/999/, respond: { status: 404, json: { message: "TF401232: Work item 999 does not exist.", typeKey: "WorkItemNotFoundException" } } }]);
    const res = await ctx.call("get_work_item", { id: 999 });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Failed to get work item 999");
    expect(text(res)).toContain("TF401232");
    expect(structured(res).status).toBe(404);
  });

  it("update_work_item requires state and assignedTo and sends a JSON patch", async () => {
    ctx = await setup([
      {
        match: /^\/Alpha\/_apis\/wit\/workitems\/5\?/,
        method: "PATCH",
        respond: (req) => ({ json: workItemFixture(5, { "System.State": "Resolved", "System.AssignedTo": { displayName: "Me", uniqueName: "CORP\\me" } }) }),
      },
    ]);
    const missing = await ctx.call("update_work_item", { id: 5, state: "Resolved" });
    expect(missing.isError).toBe(true);

    const res = await ctx.call("update_work_item", { id: 5, state: "Resolved", assignedTo: "Me <CORP\\me>", comment: "fixed", tags: ["x"] });
    expect(res.isError).toBeFalsy();
    const req = ctx.requests.at(-1)!;
    expect(req.method).toBe("PATCH");
    expect(req.headers["content-type"]).toBe("application/json-patch+json");
    expect(req.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "Resolved" },
      { op: "add", path: "/fields/System.AssignedTo", value: "Me <CORP\\me>" },
      { op: "add", path: "/fields/System.Tags", value: "x" },
      { op: "add", path: "/fields/System.History", value: "<div>fixed</div>" },
    ]);
    expect((structured(res).workItem as { state: string }).state).toBe("Resolved");
  });

  it("add_work_item_comment resolves the project from the work item when not configured", async () => {
    ctx = await setup(
      [
        { match: /^\/_apis\/wit\/workitems\/42\?fields=System.TeamProject/, respond: { json: { id: 42, rev: 1, fields: { "System.TeamProject": "Gamma" } } } },
        { match: /^\/Gamma\/_apis\/wit\/workItems\/42\/comments\?/, method: "POST", respond: { json: { id: 99, workItemId: 42, version: 1, text: "<div>hello</div>" } } },
      ],
      { ...config, defaultProject: undefined }
    );
    const res = await ctx.call("add_work_item_comment", { id: 42, text: "hello" });
    expect(res.isError).toBeFalsy();
    expect(structured(res).id).toBe(99);
    expect(ctx.requests[1]!.body).toEqual({ text: "<div>hello</div>" });
  });

  it("update_work_item_comment patches the comment", async () => {
    ctx = await setup([{ match: /workItems\/1\/comments\/7\?/, method: "PATCH", respond: { json: { id: 7, workItemId: 1, version: 2, text: "<div>new</div>" } } }]);
    const res = await ctx.call("update_work_item_comment", { id: 1, commentId: 7, text: "new" });
    expect(res.isError).toBeFalsy();
    expect(structured(res).version).toBe(2);
  });

  it("run_query executes a saved query by id and materialises items via workitemsbatch", async () => {
    const guid = "11111111-2222-3333-4444-555555555555";
    ctx = await setup([
      {
        match: new RegExp(`^/Alpha/_apis/wit/wiql/${guid}\\?`),
        respond: { json: { queryType: "flat", columns: [{ referenceName: "System.Id" }, { referenceName: "System.Title" }], workItems: [{ id: 1, url: "" }, { id: 2, url: "" }] } },
      },
      { match: /^\/Alpha\/_apis\/wit\/workitemsbatch\?/, method: "POST", respond: (req) => ({ json: { count: 2, value: (req.body as { ids: number[] }).ids.map((id) => workItemFixture(id)) } }) },
    ]);
    const res = await ctx.call("run_query", { queryId: guid });
    expect(res.isError).toBeFalsy();
    const data = structured(res);
    expect(data.totalMatches).toBe(2);
    expect((data.workItems as unknown[]).length).toBe(2);
    expect((ctx.requests[1]!.body as { fields: string[] }).fields).toEqual(["System.Title"]);
  });

  it("run_query with extraWhere rewrites the saved WIQL", async () => {
    const guid = "11111111-2222-3333-4444-555555555555";
    ctx = await setup([
      {
        match: new RegExp(`^/Alpha/_apis/wit/queries/${guid}\\?`),
        respond: { json: { id: guid, name: "Open", path: "Shared Queries/Open", queryType: "flat", wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active' ORDER BY [System.Id]" } },
      },
      { match: /^\/Alpha\/_apis\/wit\/wiql\?/, method: "POST", respond: { json: { queryType: "flat", columns: [{ referenceName: "System.Id" }], workItems: [] } } },
    ]);
    const res = await ctx.call("run_query", { queryId: guid, extraWhere: "[System.Tags] CONTAINS 'x'" });
    expect(res.isError).toBeFalsy();
    expect((ctx.requests[1]!.body as { query: string }).query).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE ([System.State] = 'Active') AND ([System.Tags] CONTAINS 'x') ORDER BY [System.Id]"
    );
    expect(structured(res).totalMatches).toBe(0);
  });

  it("run_wiql passes the statement as-is", async () => {
    ctx = await setup([
      { match: /^\/Alpha\/_apis\/wit\/wiql\?/, method: "POST", respond: { json: { queryType: "flat", workItems: [{ id: 3, url: "" }] } } },
      { match: /workitemsbatch/, method: "POST", respond: { json: { count: 1, value: [workItemFixture(3)] } } },
    ]);
    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 3";
    const res = await ctx.call("run_wiql", { wiql });
    expect(res.isError).toBeFalsy();
    expect((ctx.requests[0]!.body as { query: string }).query).toBe(wiql);
    expect((ctx.requests[1]!.body as { $expand: string }).$expand).toBe("all");
  });

  /* ------------------------------------------------------------------ batch work items */

  it("get_work_items chunks ids and reports missing ones", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    ctx = await setup([
      {
        match: /workitemsbatch/,
        method: "POST",
        respond: (req) => {
          const wanted = (req.body as { ids: number[] }).ids.filter((id) => id !== 7);
          return { json: { count: wanted.length, value: wanted.map((id) => workItemFixture(id)) } };
        },
      },
    ]);
    const res = await ctx.call("get_work_items", { ids, fields: ["System.Title"] });
    expect(res.isError).toBeFalsy();
    const data = structured<{ summary: { total: number; ok: number; failed: number }; failed: { key: number }[] }>(res);
    expect(ctx.requests).toHaveLength(2);
    expect((ctx.requests[0]!.body as { ids: number[] }).ids).toHaveLength(200);
    expect(data.summary).toEqual({ total: 250, ok: 249, failed: 1 });
    expect(data.failed[0]!.key).toBe(7);
  });

  it("update_work_items uses $batch and maps per-item codes", async () => {
    ctx = await setup([
      {
        match: /^\/_apis\/wit\/\$batch\?/,
        method: "POST",
        respond: (req) => {
          const reqs = req.body as { uri: string; method: string; body: unknown }[];
          return {
            json: {
              count: reqs.length,
              value: reqs.map((r) => {
                const id = Number(/workItems\/(\d+)/.exec(r.uri)![1]);
                return id === 2
                  ? { code: 404, headers: {}, body: JSON.stringify({ message: "TF401232: Work item 2 does not exist." }) }
                  : { code: 200, headers: {}, body: JSON.stringify(workItemFixture(id, { "System.State": "Closed" })) };
              }),
            },
          };
        },
      },
    ]);
    const res = await ctx.call("update_work_items", { ids: [1, 2, 3], state: "Closed", assignedTo: "Me <CORP\\me>" });
    expect(res.isError).toBeFalsy();
    const data = structured<{ summary: { ok: number; failed: number }; failed: { key: number; message: string }[]; usedBatchEndpoint: boolean }>(res);
    expect(data.usedBatchEndpoint).toBe(true);
    expect(data.summary).toEqual({ total: 3, ok: 2, failed: 1 });
    expect(data.failed[0]).toMatchObject({ key: 2, status: 404 });
    expect(data.failed[0]!.message).toContain("TF401232");
    const sub = (ctx.requests[0]!.body as { uri: string; method: string; headers: Record<string, string>; body: unknown }[])[0]!;
    expect(sub).toMatchObject({ method: "PATCH", uri: "/Alpha/_apis/wit/workItems/1?api-version=6.0", headers: { "Content-Type": "application/json-patch+json" } });
    expect(sub.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "Closed" },
      { op: "add", path: "/fields/System.AssignedTo", value: "Me <CORP\\me>" },
    ]);
  });

  it("update_work_items falls back to single PATCH calls when $batch is unavailable", async () => {
    ctx = await setup([
      { match: /^\/_apis\/wit\/\$batch\?/, method: "POST", respond: { status: 404, json: { message: "not here" } } },
      { match: /^\/Alpha\/_apis\/wit\/workitems\/(\d+)\?/, method: "PATCH", respond: (req) => ({ json: workItemFixture(Number(/workitems\/(\d+)/.exec(req.path)![1])) }) },
    ]);
    const res = await ctx.call("update_work_items", { ids: [1, 2], state: "Active", assignedTo: "" });
    const data = structured<{ summary: { ok: number }; usedBatchEndpoint: boolean }>(res);
    expect(data.usedBatchEndpoint).toBe(false);
    expect(data.summary.ok).toBe(2);
    expect(ctx.requests.filter((r) => r.method === "PATCH")).toHaveLength(2);
  });

  it("add_comment_to_work_items fans out and reports per-item results", async () => {
    ctx = await setup([
      {
        match: /workItems\/(\d+)\/comments\?/,
        method: "POST",
        respond: (req: RecordedRequest) => {
          const id = Number(/workItems\/(\d+)/.exec(req.path)![1]);
          return id === 3 ? { status: 403, json: { message: "no permission" } } : { json: { id: 100 + id, workItemId: id, version: 1, text: "x" } };
        },
      },
    ]);
    const res = await ctx.call("add_comment_to_work_items", { ids: [1, 2, 3], text: "same for all" });
    const data = structured<{ summary: { ok: number; failed: number }; succeeded: { commentId: number }[]; failed: { key: number; status: number }[] }>(res);
    expect(data.summary).toEqual({ total: 3, ok: 2, failed: 1 });
    expect(data.succeeded.map((s) => s.commentId).sort()).toEqual([101, 102]);
    expect(data.failed[0]).toMatchObject({ key: 3, status: 403 });
  });

  /* ------------------------------------------------------------------ files */

  it("get_file_content returns inline text from another project/branch", async () => {
    ctx = await setup([
      {
        match: /^\/Infra\/_apis\/git\/repositories\/tools\/items\?path=\/src\/main\.ts&versionDescriptor\.version=develop&versionDescriptor\.versionType=branch&includeContent=true/,
        respond: {
          json: {
            objectId: "obj1",
            gitObjectType: "blob",
            commitId: "c1",
            path: "/src/main.ts",
            content: "console.log(1);\n",
            contentMetadata: { fileName: "main.ts", contentType: "text/plain", encoding: 65001, isBinary: false },
            latestProcessedChange: { commitId: "c1", author: { name: "Ann", email: "ann@x", date: "2026-02-01T00:00:00Z" }, comment: "init" },
          },
        },
      },
    ]);
    const res = await ctx.call("get_file_content", { repository: "tools", path: "src/main.ts", project: "Infra", branch: "develop" });
    expect(res.isError).toBeFalsy();
    const f = structured(res);
    expect(f.content).toBe("console.log(1);\n");
    expect(f.isBinary).toBe(false);
    expect(f.version).toBe("branch 'develop'");
    expect((f.latestChange as { author: string }).author).toBe("Ann <ann@x>");
  });

  it("get_file_content downloads binaries as base64", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    ctx = await setup([
      { match: /items\?path=\/img\.png.*includeContent=true/, respond: { json: { objectId: "o", gitObjectType: "blob", path: "/img.png", contentMetadata: { isBinary: true, contentType: "image/png" } } } },
      { match: /items\?path=\/img\.png.*\$format=octetStream/, respond: { bytes } },
    ]);
    const res = await ctx.call("get_file_content", { repository: "r", path: "/img.png" });
    const f = structured(res);
    expect(f.isBinary).toBe(true);
    expect(f.encoding).toBe("base64");
    expect(f.content).toBe(Buffer.from(bytes).toString("base64"));
    expect(f.size).toBe(6);
  });

  it("get_file_content explains a missing file with parent directory listing and suggestions", async () => {
    ctx = await setup([
      { match: /items\?path=\/src\/Main\.ts.*includeContent=true/, respond: { status: 404, json: { message: "TF401174: The item could not be found", typeKey: "GitItemNotFoundException" } } },
      { match: /^\/Alpha\/_apis\/git\/repositories\/app\?/, respond: { json: { id: "r1", name: "app", defaultBranch: "refs/heads/main" } } },
      { match: /refs\?filter=heads\/develop/, respond: { json: { count: 1, value: [{ name: "refs/heads/develop", objectId: "x" }] } } },
      {
        match: /items\?scopePath=\/src&recursionLevel=OneLevel/,
        respond: {
          json: {
            count: 3,
            value: [
              { objectId: "t", gitObjectType: "tree", path: "/src", isFolder: true },
              { objectId: "a", gitObjectType: "blob", path: "/src/main.ts" },
              { objectId: "b", gitObjectType: "tree", path: "/src/lib", isFolder: true },
            ],
          },
        },
      },
    ]);
    const res = await ctx.call("get_file_content", { repository: "app", path: "/src/Main.ts", branch: "develop" });
    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("File '/src/Main.ts' not found in repository 'app' (project 'Alpha') at branch 'develop'");
    expect(msg).toContain("contains: lib/, main.ts");
    expect(msg).toContain("Did you mean '/src/main.ts' (case differs)");
    const body = structured(res).body as { branchExists: boolean; repositoryExists: boolean };
    expect(body.repositoryExists).toBe(true);
    expect(body.branchExists).toBe(true);
  });

  it("get_file_content explains a missing branch", async () => {
    ctx = await setup([
      { match: /items\?path=/, respond: { status: 404, json: { message: "TF401175: The version descriptor <Branch: nope> could not be resolved", typeKey: "GitUnresolvableToCommitException" } } },
      { match: /^\/Alpha\/_apis\/git\/repositories\/app\?/, respond: { json: { id: "r1", name: "app", defaultBranch: "refs/heads/main" } } },
      { match: /refs\?filter=heads\/nope/, respond: { json: { count: 0, value: [] } } },
      { match: /refs\?filter=heads\/&/, respond: { json: { count: 2, value: [{ name: "refs/heads/main" }, { name: "refs/heads/release/1.0" }] } } },
    ]);
    const res = await ctx.call("get_file_content", { repository: "app", path: "/a.txt", branch: "nope" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Branch 'nope' does not exist in repository 'app'");
    expect(text(res)).toContain("Default branch: main");
    expect(text(res)).toContain("main, release/1.0");
  });

  it("get_file_content explains a missing repository", async () => {
    ctx = await setup([
      { match: /repositories\/ghost\/items/, respond: { status: 404, json: { message: "TF401019: The Git repository with name or identifier ghost does not exist", typeKey: "GitRepositoryNotFoundException" } } },
      { match: /^\/Alpha\/_apis\/git\/repositories\/ghost\?/, respond: { status: 404, json: { message: "TF401019" } } },
      { match: /^\/Alpha\/_apis\/git\/repositories\?/, respond: { json: { count: 2, value: [{ id: "1", name: "app" }, { id: "2", name: "tools" }] } } },
    ]);
    const res = await ctx.call("get_file_content", { repository: "ghost", path: "/a.txt" });
    expect(text(res)).toContain("Repository 'ghost' does not exist in project 'Alpha'. Available repositories: app, tools.");
  });

  it("list_directory returns entries with metadata, folders first", async () => {
    ctx = await setup([
      {
        match: /items\?scopePath=\/src&recursionLevel=OneLevel.*includeContentMetadata=true/,
        respond: {
          json: {
            count: 3,
            value: [
              { objectId: "t", gitObjectType: "tree", commitId: "c9", path: "/src", isFolder: true },
              { objectId: "a", gitObjectType: "blob", path: "/src/a.ts", contentMetadata: { contentType: "text/plain", isBinary: false }, latestProcessedChange: { commitId: "c1", author: { name: "Ann", date: "2026-01-01T00:00:00Z" }, comment: "add a" } },
              { objectId: "b", gitObjectType: "tree", path: "/src/lib", isFolder: true },
            ],
          },
        },
      },
    ]);
    const res = await ctx.call("list_directory", { repository: "app", path: "src" });
    expect(res.isError).toBeFalsy();
    const data = structured<{ count: number; entries: { name: string; isFolder: boolean; latestChange?: { comment: string } }[]; commitId: string }>(res);
    expect(data.count).toBe(2);
    expect(data.commitId).toBe("c9");
    expect(data.entries.map((e) => e.name)).toEqual(["lib", "a.ts"]);
    expect(data.entries[1]!.latestChange?.comment).toBe("add a");
  });

  it("get_files_content uses itemsbatch then fetches contents in parallel, reporting missing paths", async () => {
    ctx = await setup([
      {
        match: /itemsbatch\?/,
        method: "POST",
        respond: (req) => {
          const descriptors = (req.body as { itemDescriptors: { path: string }[] }).itemDescriptors;
          return {
            json: {
              count: descriptors.length,
              value: descriptors.map((d) => (d.path === "/missing.txt" ? [] : [{ objectId: "o-" + d.path, gitObjectType: "blob", path: d.path, contentMetadata: { isBinary: false } }])),
            },
          };
        },
      },
      {
        match: /items\?path=\/(a|b)\.txt.*includeContent=true/,
        respond: (req) => {
          const p = /path=(\/[ab]\.txt)/.exec(req.path)![1]!;
          return { json: { objectId: "o" + p, gitObjectType: "blob", path: p, content: `content of ${p}`, contentMetadata: { isBinary: false } } };
        },
      },
      { match: /^\/Alpha\/_apis\/git\/repositories\/app\?/, respond: { json: { id: "r1", name: "app", defaultBranch: "refs/heads/main" } } },
      { match: /items\?scopePath=\/&recursionLevel=OneLevel/, respond: { json: { count: 2, value: [{ objectId: "t", gitObjectType: "tree", path: "/", isFolder: true }, { objectId: "a", gitObjectType: "blob", path: "/a.txt" }] } } },
    ]);
    const res = await ctx.call("get_files_content", { repository: "app", paths: ["a.txt", "/b.txt", "/missing.txt"] });
    expect(res.isError).toBeFalsy();
    const data = structured<{ summary: { ok: number; failed: number }; succeeded: { path: string; content: string }[]; failed: { key: string; message: string }[] }>(res);
    expect(data.summary).toEqual({ total: 3, ok: 2, failed: 1 });
    expect(data.succeeded.map((s) => s.content).sort()).toEqual(["content of /a.txt", "content of /b.txt"]);
    expect(data.failed[0]!.key).toBe("/missing.txt");
    expect(data.failed[0]!.message).toContain("File '/missing.txt' not found");
    expect(data.failed[0]!.message).toContain("contains: a.txt");
  });

  it("list_repositories lists repos of the default project", async () => {
    ctx = await setup([{ match: /^\/Alpha\/_apis\/git\/repositories\?/, respond: { json: { count: 1, value: [{ id: "1", name: "app", defaultBranch: "refs/heads/main", project: { id: "p", name: "Alpha" } }] } } }]);
    const res = await ctx.call("list_repositories", {});
    expect((structured(res).repositories as { defaultBranch: string }[])[0]!.defaultBranch).toBe("main");
  });

  /* ------------------------------------------------------------------ identity */

  it("get_current_identity combines connectionData and identities", async () => {
    ctx = await setup([
      {
        match: /^\/_apis\/connectionData\?/,
        respond: {
          json: {
            authenticatedUser: {
              id: "u-42",
              descriptor: "System.Security.Principal.WindowsIdentity;S-1-5-21-1-2-3-1001\\CORP\\jdoe",
              providerDisplayName: "Jane Doe",
              properties: { Account: { $type: "System.String", $value: "CORP\\jdoe" } },
            },
            authorizedUser: { id: "u-42", providerDisplayName: "Jane Doe" },
            instanceId: "inst",
            deploymentType: "onPremises",
          },
        },
      },
      {
        match: /^\/_apis\/identities\?identityIds=u-42/,
        respond: { json: { count: 1, value: [{ id: "u-42", providerDisplayName: "Jane Doe", properties: { Account: { $value: "jdoe" }, Domain: { $value: "CORP" }, Mail: { $value: "jane@corp.com" } } }] } },
      },
    ]);
    const res = await ctx.call("get_current_identity", {});
    expect(res.isError).toBeFalsy();
    const data = structured<{ user: { assignedToValue: string; mail: string; uniqueName: string }; server: { deploymentType: string }; enrichedFromIdentitiesApi: boolean }>(res);
    expect(data.user.uniqueName).toBe("CORP\\jdoe");
    expect(data.user.mail).toBe("jane@corp.com");
    expect(data.user.assignedToValue).toBe("Jane Doe <CORP\\jdoe>");
    expect(data.server.deploymentType).toBe("onPremises");
    expect(data.enrichedFromIdentitiesApi).toBe(true);
    expect(ctx.requests[0]!.path).toContain("api-version=6.0-preview");
  });

  it("get_current_identity works when the identities API is unavailable", async () => {
    ctx = await setup([
      {
        match: /^\/_apis\/connectionData\?/,
        respond: { json: { authenticatedUser: { id: "u-1", descriptor: "Microsoft.IdentityModel.Claims.ClaimsIdentity;jane@corp.com", providerDisplayName: "Jane" } } },
      },
      { match: /^\/_apis\/identities/, respond: { status: 404, json: { message: "nope" } } },
    ]);
    const res = await ctx.call("get_current_identity", {});
    const data = structured<{ user: { assignedToValue: string }; enrichedFromIdentitiesApi: boolean }>(res);
    expect(data.enrichedFromIdentitiesApi).toBe(false);
    expect(data.user.assignedToValue).toBe("Jane <jane@corp.com>");
  });

  it("search_identities filters groups by default", async () => {
    ctx = await setup([
      {
        match: /^\/_apis\/identities\?searchFilter=General&filterValue=doe/,
        respond: {
          json: {
            count: 2,
            value: [
              { id: "1", providerDisplayName: "Jane Doe", properties: { Account: { $value: "CORP\\jdoe" } } },
              { id: "2", providerDisplayName: "[Alpha]\\Doers", isContainer: true, properties: { SchemaClassName: { $value: "Group" } } },
            ],
          },
        },
      },
    ]);
    const res = await ctx.call("search_identities", { query: "doe" });
    const data = structured<{ count: number; identities: { assignedToValue: string }[] }>(res);
    expect(data.count).toBe(1);
    expect(data.identities[0]!.assignedToValue).toBe("Jane Doe <CORP\\jdoe>");
    const withGroups = await ctx.call("search_identities", { query: "doe", includeGroups: true });
    expect(structured<{ count: number }>(withGroups).count).toBe(2);
  });
});
