import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TfsConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { applyEdits, pullRequestArtifactUri, ZERO_OBJECT_ID } from "../src/services/gitwrite.js";
import { BASE_URL, createMockFetch, workItemFixture, type RecordedRequest, type Route } from "./helpers/mockFetch.js";

const config: TfsConfig = { baseUrl: BASE_URL, pat: "pat", defaultProject: "Alpha", apiVersion: "6.0", batchConcurrency: 3 };

const DEVELOP_TIP = "a".repeat(40);
const FEATURE_TIP = "b".repeat(40);
const NEW_COMMIT = "c".repeat(40);

const repoFixture = {
  id: "repo-1",
  name: "tools",
  defaultBranch: "refs/heads/main",
  webUrl: `${BASE_URL}/Alpha/_git/tools`,
  project: { id: "proj-1", name: "Alpha" },
};

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
const filterOf = (req: RecordedRequest) => new URL(req.url).searchParams.get("filter") ?? "";

/** Routes for a repo with branches develop (tip A) and, when `featureExists`, feature/x (tip B). */
function baseRoutes(opts: { featureExists?: boolean; fileContent?: string; linkedWorkItems?: number[] } = {}): Route[] {
  const branches: Record<string, string> = { develop: DEVELOP_TIP, main: DEVELOP_TIP };
  if (opts.featureExists) branches["feature/x"] = FEATURE_TIP;
  return [
    { method: "GET", match: /^\/Alpha\/_apis\/git\/repositories\/tools\?/, respond: { json: repoFixture } },
    {
      method: "GET",
      match: /^\/Alpha\/_apis\/git\/repositories\/tools\/refs\?/,
      respond: (req) => {
        const filter = filterOf(req).replace(/^heads\//, "");
        const value = Object.entries(branches)
          .filter(([name]) => name.startsWith(filter))
          .map(([name, objectId]) => ({ name: `refs/heads/${name}`, objectId }));
        return { json: { count: value.length, value } };
      },
    },
    {
      method: "POST",
      match: /^\/Alpha\/_apis\/git\/repositories\/tools\/refs\?/,
      respond: (req) => {
        const [u] = req.body as { name: string; newObjectId: string }[];
        return { json: { count: 1, value: [{ name: u!.name, oldObjectId: ZERO_OBJECT_ID, newObjectId: u!.newObjectId, success: true, updateStatus: "succeeded" }] } };
      },
    },
    {
      method: "GET",
      match: /^\/Alpha\/_apis\/git\/repositories\/tools\/items\?/,
      respond: (req) => {
        const path = new URL(req.url).searchParams.get("path");
        if (path === "/missing.txt") return { status: 404, json: { message: "Item not found", typeKey: "GitItemNotFoundException" } };
        return {
          json: {
            objectId: "blob-1",
            gitObjectType: "blob",
            commitId: DEVELOP_TIP,
            path,
            content: opts.fileContent ?? "const a = 1;\nconst b = 2;\n",
            contentMetadata: { fileName: "x.ts", contentType: "text/plain", encoding: 65001, isBinary: false },
          },
        };
      },
    },
    {
      method: "POST",
      match: /^\/Alpha\/_apis\/git\/repositories\/tools\/pushes\?/,
      respond: (req) => {
        const body = req.body as { refUpdates: { name: string }[] };
        return { json: { pushId: 7, commits: [{ commitId: NEW_COMMIT, comment: "x" }], refUpdates: [{ name: body.refUpdates[0]!.name, newObjectId: NEW_COMMIT }] } };
      },
    },
    {
      method: "POST",
      match: /^\/Alpha\/_apis\/git\/repositories\/tools\/pullrequests\?/,
      respond: (req) => {
        const body = req.body as Record<string, unknown>;
        return {
          json: {
            pullRequestId: 55,
            status: "active",
            title: body.title,
            description: body.description,
            isDraft: body.isDraft,
            sourceRefName: body.sourceRefName,
            targetRefName: body.targetRefName,
            createdBy: { displayName: "Jane Doe" },
            creationDate: "2026-09-12T00:00:00Z",
            repository: repoFixture,
          },
        };
      },
    },
    {
      method: "GET",
      match: /^\/Alpha\/_apis\/git\/repositories\/tools\/pullRequests\/55\/workitems\?/,
      respond: { json: { count: (opts.linkedWorkItems ?? []).length, value: (opts.linkedWorkItems ?? []).map((id) => ({ id: String(id) })) } },
    },
    { method: "PATCH", match: /^\/_apis\/wit\/workitems\/\d+\?/, respond: (req) => ({ json: workItemFixture(Number(req.path.match(/workitems\/(\d+)/)![1])) }) },
  ];
}

describe("applyEdits", () => {
  it("replaces a unique match and rejects ambiguous or missing ones", () => {
    expect(applyEdits("/f", "a b a", [{ find: "b", replace: "c" }])).toBe("a c a");
    expect(() => applyEdits("/f", "a b a", [{ find: "a", replace: "c" }])).toThrow(/more than once/);
    expect(applyEdits("/f", "a b a", [{ find: "a", replace: "c", replaceAll: true }])).toBe("c b c");
    expect(() => applyEdits("/f", "a b a", [{ find: "zzz", replace: "c" }])).toThrow(/not found/);
    expect(() => applyEdits("/f", "a b a", [{ find: "b", replace: "b" }])).toThrow(/no change/);
  });
});

describe("Git write tools", () => {
  let ctx: Awaited<ReturnType<typeof setup>> | undefined;
  beforeEach(() => (ctx = undefined));
  afterEach(async () => ctx?.close());

  /* ------------------------------------------------------------------ create_branch */

  it("create_branch resolves the target tip and posts a ref update from the zero object id", async () => {
    ctx = await setup(baseRoutes());
    const res = await ctx.call("create_branch", { repository: "tools", name: "feature/x", fromBranch: "develop" });
    expect(res.isError).toBeFalsy();
    const data = structured(res);
    expect(data.created).toBe(true);
    expect(data.branch).toBe("feature/x");
    expect(data.objectId).toBe(DEVELOP_TIP);
    expect(data.sourceBranch).toBe("develop");
    expect(data.webUrl).toBe(`${BASE_URL}/Alpha/_git/tools?version=GBfeature%2Fx`);

    const post = ctx.requests.find((r) => r.method === "POST" && r.path.includes("/refs?"));
    expect(post?.body).toEqual([{ name: "refs/heads/feature/x", oldObjectId: ZERO_OBJECT_ID, newObjectId: DEVELOP_TIP }]);
  });

  it("create_branch defaults to the repository default branch", async () => {
    ctx = await setup(baseRoutes());
    const res = await ctx.call("create_branch", { repository: "tools", name: "hotfix/1" });
    expect(structured(res).sourceBranch).toBe("main");
  });

  it("create_branch explains a missing source branch and lists existing ones", async () => {
    ctx = await setup(baseRoutes());
    const res = await ctx.call("create_branch", { repository: "tools", name: "feature/x", fromBranch: "nope" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Branch 'nope' does not exist/);
    expect(text(res)).toMatch(/develop/);
    expect(ctx.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("create_branch fails on an existing branch unless ifExists is reuse", async () => {
    ctx = await setup(baseRoutes({ featureExists: true }));
    const failed = await ctx.call("create_branch", { repository: "tools", name: "feature/x", fromBranch: "develop" });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(/already exists/);

    const reused = await ctx.call("create_branch", { repository: "tools", name: "feature/x", fromBranch: "develop", ifExists: "reuse" });
    expect(reused.isError).toBeFalsy();
    expect(structured(reused).created).toBe(false);
    expect(structured(reused).objectId).toBe(FEATURE_TIP);
    expect(ctx.requests.some((r) => r.method === "POST")).toBe(false);
  });

  /* ------------------------------------------------------------------ commit_file_changes */

  it("commit_file_changes pushes rawtext, base64 and delete changes against the branch tip", async () => {
    ctx = await setup(baseRoutes({ featureExists: true }));
    const res = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "feature/x",
      message: "Add files",
      changes: [
        { path: "src/new.ts", changeType: "add", content: "export const x = 1;\n" },
        { path: "/assets/logo.png", changeType: "edit", content: "AAEC", encoding: "base64" },
        { path: "/old.txt", changeType: "delete" },
      ],
    });
    expect(res.isError).toBeFalsy();
    const data = structured(res);
    expect(data.commitId).toBe(NEW_COMMIT);
    expect(data.previousTip).toBe(FEATURE_TIP);
    expect(data.webUrl).toBe(`${BASE_URL}/Alpha/_git/tools/commit/${NEW_COMMIT}`);
    expect(data.changes).toEqual([
      { path: "/src/new.ts", changeType: "add", appliedEdits: 0, bytes: 20 },
      { path: "/assets/logo.png", changeType: "edit", appliedEdits: 0, bytes: 3 },
      { path: "/old.txt", changeType: "delete", appliedEdits: 0, bytes: undefined },
    ]);

    const push = ctx.requests.find((r) => r.method === "POST" && r.path.includes("/pushes?"));
    expect(push?.body).toEqual({
      refUpdates: [{ name: "refs/heads/feature/x", oldObjectId: FEATURE_TIP }],
      commits: [
        {
          comment: "Add files",
          changes: [
            { changeType: "add", item: { path: "/src/new.ts" }, newContent: { content: "export const x = 1;\n", contentType: "rawtext" } },
            { changeType: "edit", item: { path: "/assets/logo.png" }, newContent: { content: "AAEC", contentType: "base64encoded" } },
            { changeType: "delete", item: { path: "/old.txt" } },
          ],
        },
      ],
    });
  });

  it("commit_file_changes applies find/replace edits to the current file content", async () => {
    ctx = await setup(baseRoutes({ featureExists: true }));
    const res = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "feature/x",
      message: "Bump b",
      changes: [{ path: "/src/x.ts", changeType: "edit", edits: [{ find: "const b = 2;", replace: "const b = 3;" }] }],
    });
    expect(res.isError).toBeFalsy();
    expect(structured(res).changes).toEqual([{ path: "/src/x.ts", changeType: "edit", appliedEdits: 1, bytes: 26 }]);

    const read = ctx.requests.find((r) => r.method === "GET" && r.path.includes("/items?"));
    const readUrl = new URL(read!.url);
    expect(readUrl.searchParams.get("versionDescriptor.version")).toBe(FEATURE_TIP);
    expect(readUrl.searchParams.get("versionDescriptor.versionType")).toBe("commit");

    const push = ctx.requests.find((r) => r.method === "POST" && r.path.includes("/pushes?"));
    const body = push?.body as { commits: { changes: { newContent: { content: string } }[] }[] };
    expect(body.commits[0]!.changes[0]!.newContent.content).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("commit_file_changes rejects ambiguous edits, missing files and invalid change shapes without pushing", async () => {
    ctx = await setup(baseRoutes({ featureExists: true }));
    const ambiguous = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "feature/x",
      message: "m",
      changes: [{ path: "/src/x.ts", changeType: "edit", edits: [{ find: "const", replace: "let" }] }],
    });
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toMatch(/more than once/);

    const missing = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "feature/x",
      message: "m",
      changes: [{ path: "/missing.txt", changeType: "edit", edits: [{ find: "a", replace: "b" }] }],
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/does not exist .* use changeType 'add'/);

    const both = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "feature/x",
      message: "m",
      changes: [{ path: "/src/x.ts", changeType: "edit", content: "x", edits: [{ find: "a", replace: "b" }] }],
    });
    expect(both.isError).toBe(true);
    expect(text(both)).toMatch(/either 'content' or 'edits'/);

    const addWithEdits = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "feature/x",
      message: "m",
      changes: [{ path: "/n.txt", changeType: "add", edits: [{ find: "a", replace: "b" }] }],
    });
    expect(addWithEdits.isError).toBe(true);

    expect(ctx.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("commit_file_changes refuses to commit when expectedBranchTip is stale or the branch is missing", async () => {
    ctx = await setup(baseRoutes({ featureExists: true }));
    const stale = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "feature/x",
      message: "m",
      expectedBranchTip: DEVELOP_TIP,
      changes: [{ path: "/n.txt", changeType: "add", content: "x" }],
    });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/not at the expected/);

    const noBranch = await ctx.call("commit_file_changes", {
      repository: "tools",
      branch: "ghost",
      message: "m",
      changes: [{ path: "/n.txt", changeType: "add", content: "x" }],
    });
    expect(noBranch.isError).toBe(true);
    expect(text(noBranch)).toMatch(/Branch 'ghost' does not exist/);
    expect(ctx.requests.some((r) => r.method === "POST")).toBe(false);
  });

  /* ------------------------------------------------------------------ create_pull_request */

  it("create_pull_request sends workItemRefs and reports links TFS recorded", async () => {
    ctx = await setup(baseRoutes({ featureExists: true, linkedWorkItems: [42, 43] }));
    const res = await ctx.call("create_pull_request", {
      repository: "tools",
      sourceBranch: "feature/x",
      targetBranch: "refs/heads/develop",
      title: "Fix it",
      description: "Details",
      workItemIds: [42, 43],
      reviewers: ["u-9"],
      isDraft: true,
    });
    expect(res.isError).toBeFalsy();
    const data = structured(res);
    expect(data.pullRequestId).toBe(55);
    expect(data.sourceBranch).toBe("feature/x");
    expect(data.targetBranch).toBe("develop");
    expect(data.webUrl).toBe(`${BASE_URL}/Alpha/_git/tools/pullrequest/55`);
    expect(data.workItems).toEqual([
      { id: 42, linked: true, method: "workItemRefs" },
      { id: 43, linked: true, method: "workItemRefs" },
    ]);
    expect(text(res)).toMatch(/linked 2 work item/);

    const post = ctx.requests.find((r) => r.method === "POST" && r.path.includes("/pullrequests?"));
    expect(post?.body).toEqual({
      sourceRefName: "refs/heads/feature/x",
      targetRefName: "refs/heads/develop",
      title: "Fix it",
      description: "Details",
      isDraft: true,
      workItemRefs: [{ id: "42" }, { id: "43" }],
      reviewers: [{ id: "u-9" }],
    });
    expect(ctx.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("create_pull_request falls back to an ArtifactLink relation for work items TFS did not link", async () => {
    ctx = await setup(baseRoutes({ featureExists: true, linkedWorkItems: [42] }));
    const res = await ctx.call("create_pull_request", {
      repository: "tools",
      sourceBranch: "feature/x",
      targetBranch: "develop",
      title: "Fix it",
      workItemIds: [42, 43],
    });
    expect(res.isError).toBeFalsy();
    expect(structured(res).workItems).toEqual([
      { id: 42, linked: true, method: "workItemRefs" },
      { id: 43, linked: true, method: "artifactLink" },
    ]);

    const patch = ctx.requests.find((r) => r.method === "PATCH");
    expect(patch?.path).toMatch(/^\/_apis\/wit\/workitems\/43\?/);
    expect(patch?.headers["content-type"]).toBe("application/json-patch+json");
    expect(patch?.body).toEqual([
      {
        op: "add",
        path: "/relations/-",
        value: { rel: "ArtifactLink", url: pullRequestArtifactUri("proj-1", "repo-1", 55), attributes: { name: "Pull Request" } },
      },
    ]);
    expect(pullRequestArtifactUri("proj-1", "repo-1", 55)).toBe("vstfs:///Git/PullRequestId/proj-1%2Frepo-1%2F55");
  });

  it("create_pull_request reports link failures without failing the pull request", async () => {
    const routes = baseRoutes({ featureExists: true, linkedWorkItems: [] }).filter((r) => r.method !== "PATCH");
    routes.push({ method: "PATCH", match: /^\/_apis\/wit\/workitems\/\d+\?/, respond: { status: 403, json: { message: "Forbidden by rule", typeKey: "X" } } });
    ctx = await setup(routes);
    const res = await ctx.call("create_pull_request", { repository: "tools", sourceBranch: "feature/x", targetBranch: "develop", title: "T", workItemIds: [43] });
    expect(res.isError).toBeFalsy();
    expect(structured(res).workItems).toEqual([{ id: 43, linked: false, method: "artifactLink", error: "Forbidden by rule" }]);
    expect(text(res)).toMatch(/linked 0\/1 work item/);
  });

  it("create_pull_request rejects identical source and target", async () => {
    ctx = await setup(baseRoutes({ featureExists: true }));
    const res = await ctx.call("create_pull_request", { repository: "tools", sourceBranch: "develop", targetBranch: "develop", title: "T" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/both 'develop'/);
  });

  /* ------------------------------------------------------------------ composite */

  it("create_branch_commit_and_pull_request runs all three steps in order", async () => {
    ctx = await setup(baseRoutes({ linkedWorkItems: [42] }));
    const res = await ctx.call("create_branch_commit_and_pull_request", {
      repository: "tools",
      newBranch: "feature/x",
      targetBranch: "develop",
      message: "Bump b",
      changes: [{ path: "/src/x.ts", changeType: "edit", edits: [{ find: "const b = 2;", replace: "const b = 3;" }] }],
      workItemIds: [42],
    });
    expect(res.isError).toBeFalsy();
    const data = structured<{ branch: Record<string, unknown>; commit: Record<string, unknown>; pullRequest: Record<string, unknown> }>(res);
    expect(data.branch).toMatchObject({ branch: "feature/x", created: true, objectId: DEVELOP_TIP, sourceBranch: "develop" });
    expect(data.commit).toMatchObject({ commitId: NEW_COMMIT, message: "Bump b" });
    expect(data.pullRequest).toMatchObject({ pullRequestId: 55, title: "Bump b", sourceBranch: "feature/x", targetBranch: "develop" });
    expect(data.pullRequest.workItems).toEqual([{ id: 42, linked: true, method: "workItemRefs" }]);
    expect(text(res)).toMatch(/Branch 'feature\/x' created, commit c+ \(1 change\(s\)\), pull request #55/);

    const writes = ctx.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path.split("?")[0]}`);
    expect(writes).toEqual([
      "POST /Alpha/_apis/git/repositories/tools/refs",
      "POST /Alpha/_apis/git/repositories/tools/pushes",
      "POST /Alpha/_apis/git/repositories/tools/pullrequests",
    ]);
    // the commit is pushed on top of the freshly created branch tip
    const push = ctx.requests.find((r) => r.method === "POST" && r.path.includes("/pushes?"));
    expect((push?.body as { refUpdates: { oldObjectId: string }[] }).refUpdates[0]!.oldObjectId).toBe(DEVELOP_TIP);
    // the PR uses the commit message as title by default
    const pr = ctx.requests.find((r) => r.method === "POST" && r.path.includes("/pullrequests?"));
    expect((pr?.body as { title: string }).title).toBe("Bump b");
  });

  it("create_branch_commit_and_pull_request reports completed steps when the commit fails", async () => {
    ctx = await setup(baseRoutes());
    const res = await ctx.call("create_branch_commit_and_pull_request", {
      repository: "tools",
      newBranch: "feature/x",
      targetBranch: "develop",
      message: "m",
      title: "T",
      changes: [{ path: "/src/x.ts", changeType: "edit", edits: [{ find: "nope", replace: "x" }] }],
    });
    expect(res.isError).toBe(true);
    const data = structured(res);
    expect(data.failedStep).toBe("commit");
    expect(data.completedSteps).toEqual(["branch"]);
    expect(data.branch).toMatchObject({ branch: "feature/x", created: true });
    expect(data.commit).toBeUndefined();
    expect(text(res)).toMatch(/failed while committing the changes/);
    expect(text(res)).toMatch(/completed steps: branch/);
    expect(text(res)).toMatch(/call commit_file_changes, then create_pull_request/);
    expect(ctx.requests.some((r) => r.path.includes("/pushes?"))).toBe(false);
  });

  it("create_branch_commit_and_pull_request reports branch and commit when the pull request fails", async () => {
    const routes = baseRoutes().filter((r) => !(r.method === "POST" && String(r.match).includes("pullrequests")));
    routes.push({ method: "POST", match: /pullrequests\?/, respond: { status: 409, json: { message: "An active pull request already exists", typeKey: "GitPullRequestExistsException" } } });
    ctx = await setup(routes);
    const res = await ctx.call("create_branch_commit_and_pull_request", {
      repository: "tools",
      newBranch: "feature/x",
      targetBranch: "develop",
      message: "m",
      changes: [{ path: "/n.txt", changeType: "add", content: "x" }],
    });
    expect(res.isError).toBe(true);
    const data = structured(res);
    expect(data.failedStep).toBe("pullRequest");
    expect(data.completedSteps).toEqual(["branch", "commit"]);
    expect(data.status).toBe(409);
    expect(text(res)).toMatch(/An active pull request already exists/);
    expect(text(res)).toMatch(/call create_pull_request for 'feature\/x' -> 'develop'/);
  });

  it("create_branch_commit_and_pull_request stops before writing when the new branch already exists", async () => {
    ctx = await setup(baseRoutes({ featureExists: true }));
    const res = await ctx.call("create_branch_commit_and_pull_request", {
      repository: "tools",
      newBranch: "feature/x",
      targetBranch: "develop",
      message: "m",
      changes: [{ path: "/n.txt", changeType: "add", content: "x" }],
    });
    expect(res.isError).toBe(true);
    expect(structured(res).failedStep).toBe("branch");
    expect(structured(res).completedSteps).toEqual([]);
    expect(ctx.requests.some((r) => r.method !== "GET")).toBe(false);

    const reused = await ctx.call("create_branch_commit_and_pull_request", {
      repository: "tools",
      newBranch: "feature/x",
      targetBranch: "develop",
      message: "m",
      changes: [{ path: "/n.txt", changeType: "add", content: "x" }],
      reuseExistingBranch: true,
    });
    expect(reused.isError).toBeFalsy();
    expect(structured<{ branch: { created: boolean; objectId: string } }>(reused).branch).toMatchObject({ created: false, objectId: FEATURE_TIP });
    const push = ctx.requests.find((r) => r.method === "POST" && r.path.includes("/pushes?"));
    expect((push?.body as { refUpdates: { oldObjectId: string }[] }).refUpdates[0]!.oldObjectId).toBe(FEATURE_TIP);
  });

  it("requires a project when none is configured", async () => {
    ctx = await setup(baseRoutes(), { ...config, defaultProject: undefined });
    const res = await ctx.call("create_branch", { repository: "tools", name: "x" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/project is required/i);
  });
});
