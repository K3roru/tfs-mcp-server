import { describe, expect, it } from "vitest";
import { TfsApiError, TfsClient } from "../src/client.js";
import { loadConfig, resolveProject, ConfigError } from "../src/config.js";
import { BASE_URL, createMockFetch } from "./helpers/mockFetch.js";

const config = { baseUrl: BASE_URL, pat: "secret-pat", apiVersion: "6.0" };

describe("config", () => {
  it("loads and normalises env", () => {
    const c = loadConfig({ TFS_BASE_URL: "https://tfs.example.com/tfs/DefaultCollection/", TFS_PAT: " pat ", TFS_DEFAULT_PROJECT: "Alpha" });
    expect(c.baseUrl).toBe("https://tfs.example.com/tfs/DefaultCollection");
    expect(c.pat).toBe("pat");
    expect(c.defaultProject).toBe("Alpha");
    expect(c.apiVersion).toBe("6.0");
    expect(c.batchConcurrency).toBe(5);
  });

  it("rejects missing values", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ TFS_BASE_URL: "not a url", TFS_PAT: "x" })).toThrow(/valid URL/);
    expect(() => loadConfig({ TFS_BASE_URL: BASE_URL, TFS_PAT: "x", TFS_BATCH_CONCURRENCY: "0" })).toThrow(/CONCURRENCY/);
  });

  it("resolves project with override precedence", () => {
    expect(resolveProject({ defaultProject: "Alpha" }, undefined)).toBe("Alpha");
    expect(resolveProject({ defaultProject: "Alpha" }, "Beta")).toBe("Beta");
    expect(resolveProject({ defaultProject: undefined }, undefined)).toBeUndefined();
    expect(() => resolveProject({ defaultProject: undefined }, undefined, true)).toThrow(/project/);
  });
});

describe("TfsClient.buildUrl", () => {
  const client = new TfsClient(config);

  it("builds collection-scoped URLs", () => {
    expect(client.buildUrl({ path: "connectionData", apiVersion: "6.0-preview" })).toBe(
      `${BASE_URL}/_apis/connectionData?api-version=6.0-preview`
    );
  });

  it("builds project-scoped URLs with encoded project and query", () => {
    const url = client.buildUrl({
      project: "My Project",
      path: "git/repositories/repo/items",
      query: { path: "/src/a b.ts", "versionDescriptor.version": "develop", skip: undefined },
    });
    expect(url).toBe(
      `${BASE_URL}/My%20Project/_apis/git/repositories/repo/items?path=%2Fsrc%2Fa+b.ts&versionDescriptor.version=develop&api-version=6.0`
    );
  });

  it("builds relative URIs for $batch sub-requests", () => {
    expect(client.buildRelativeUri({ project: "Alpha", path: "wit/workItems/42" })).toBe("/Alpha/_apis/wit/workItems/42?api-version=6.0");
  });
});

describe("TfsClient requests", () => {
  it("sends Basic auth with empty username and parses JSON", async () => {
    const { fetchImpl, requests } = createMockFetch([{ match: /^\/_apis\/projects/, respond: { json: { count: 1, value: [{ name: "Alpha" }] } } }]);
    const client = new TfsClient(config, fetchImpl);
    const res = await client.get<{ count: number }>({ path: "projects" });
    expect(res.count).toBe(1);
    expect(requests[0]!.headers.authorization).toBe("Basic " + Buffer.from(":secret-pat").toString("base64"));
    expect(requests[0]!.headers["x-tfs-fedauthredirect"]).toBe("Suppress");
  });

  it("maps TFS JSON errors to TfsApiError", async () => {
    const { fetchImpl } = createMockFetch([
      {
        match: /workitems\/999/,
        respond: { status: 404, json: { message: "TF401232: Work item 999 does not exist", typeKey: "WorkItemNotFoundException" } },
      },
    ]);
    const client = new TfsClient(config, fetchImpl);
    const err = await client.get({ path: "wit/workitems/999" }).catch((e) => e);
    expect(err).toBeInstanceOf(TfsApiError);
    expect(err.status).toBe(404);
    expect(err.typeKey).toBe("WorkItemNotFoundException");
    expect(err.message).toContain("TF401232");
    expect(err.url).toContain("/_apis/wit/workitems/999");
  });

  it("treats 203 / redirects as authentication failures", async () => {
    const { fetchImpl } = createMockFetch([{ match: /.*/, respond: { status: 203, text: "<html>sign in</html>", headers: { "content-type": "text/html" } } }]);
    const client = new TfsClient(config, fetchImpl);
    const err = await client.get({ path: "connectionData" }).catch((e) => e);
    expect(err).toBeInstanceOf(TfsApiError);
    expect(err.typeKey).toBe("AuthenticationRedirect");
    expect(err.message).toMatch(/PAT/);
  });

  it("rejects HTML bodies when JSON was expected", async () => {
    const { fetchImpl } = createMockFetch([{ match: /.*/, respond: { status: 200, text: "<html>login</html>", headers: { "content-type": "text/html" } } }]);
    const client = new TfsClient(config, fetchImpl);
    const err = await client.get({ path: "connectionData" }).catch((e) => e);
    expect(err.typeKey).toBe("UnexpectedHtmlResponse");
  });

  it("uses json-patch content type for jsonPatch()", async () => {
    const { fetchImpl, requests } = createMockFetch([{ match: /workitems\/1/, method: "PATCH", respond: { json: { id: 1 } } }]);
    const client = new TfsClient(config, fetchImpl);
    await client.jsonPatch({ path: "wit/workitems/1", body: [{ op: "add", path: "/fields/System.State", value: "Active" }] });
    expect(requests[0]!.headers["content-type"]).toBe("application/json-patch+json");
    expect(requests[0]!.method).toBe("PATCH");
  });
});
