import { describe, expect, it } from "vitest";
import { buildPatchDocument, extractIds, injectExtraWhere, toWorkItemView, identityToAssignedToValue } from "../src/services/workitems.js";
import { htmlToText, textToHtml } from "../src/util/html.js";
import { chunk, mapWithConcurrency } from "../src/util/batch.js";
import { workItemFixture } from "./helpers/mockFetch.js";

describe("buildPatchDocument", () => {
  it("always sets state and assignedTo", () => {
    const ops = buildPatchDocument({ state: "Resolved", assignedTo: "Jane Doe <CORP\\jdoe>" });
    expect(ops).toEqual([
      { op: "add", path: "/fields/System.State", value: "Resolved" },
      { op: "add", path: "/fields/System.AssignedTo", value: "Jane Doe <CORP\\jdoe>" },
    ]);
  });

  it("unassigns with empty assignedTo and supports extra fields, tags, comment and rev test", () => {
    const ops = buildPatchDocument({
      state: "New",
      assignedTo: "",
      tags: ["a", "b"],
      title: "T",
      description: "line1\nline2",
      fields: { "Custom.Field": 5, "Custom.Clear": null, "System.State": "ignored" },
      comment: "done",
      expectedRev: 7,
    });
    expect(ops[0]).toEqual({ op: "test", path: "/rev", value: 7 });
    expect(ops).toContainEqual({ op: "remove", path: "/fields/System.AssignedTo" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Tags", value: "a; b" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Title", value: "T" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Description", value: "<div>line1<br>line2</div>" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/Custom.Field", value: 5 });
    expect(ops).toContainEqual({ op: "remove", path: "/fields/Custom.Clear" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.History", value: "<div>done</div>" });
    expect(ops.filter((o) => o.path === "/fields/System.State")).toHaveLength(1);
  });
});

describe("injectExtraWhere", () => {
  it("ANDs into an existing WHERE before ORDER BY", () => {
    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed' ORDER BY [System.Id] DESC";
    expect(injectExtraWhere(wiql, "[System.Tags] CONTAINS 'hotfix'")).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE ([System.TeamProject] = @project AND [System.State] <> 'Closed') AND ([System.Tags] CONTAINS 'hotfix') ORDER BY [System.Id] DESC"
    );
  });

  it("adds WHERE when the query has none and strips a leading AND", () => {
    expect(injectExtraWhere("SELECT [System.Id] FROM WorkItems ORDER BY [System.Id]", "AND [System.State] = 'Active'")).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE ([System.State] = 'Active') ORDER BY [System.Id]"
    );
    expect(injectExtraWhere("SELECT [System.Id] FROM WorkItems", "[System.State] = 'Active'")).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE ([System.State] = 'Active')"
    );
  });

  it("ignores keywords inside literals / field names and handles tree queries with MODE", () => {
    const wiql = "SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Title] = 'where order by' AND [System.Links.LinkType] = 'Child' MODE (Recursive)";
    expect(injectExtraWhere(wiql, "[Target].[System.State] = 'Active'")).toBe(
      "SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Title] = 'where order by' AND [System.Links.LinkType] = 'Child') AND ([Target].[System.State] = 'Active') MODE (Recursive)"
    );
  });

  it("returns the original when the filter is blank", () => {
    expect(injectExtraWhere("SELECT [System.Id] FROM WorkItems", "  ")).toBe("SELECT [System.Id] FROM WorkItems");
  });
});

describe("extractIds", () => {
  it("handles flat and tree results", () => {
    expect(extractIds({ queryType: "flat", workItems: [{ id: 1, url: "" }, { id: 2, url: "" }] })).toEqual([1, 2]);
    expect(
      extractIds({
        queryType: "tree",
        workItemRelations: [
          { rel: null, source: null, target: { id: 10 } },
          { rel: "System.LinkTypes.Hierarchy-Forward", source: { id: 10 }, target: { id: 11 } },
        ],
      })
    ).toEqual([10, 11]);
  });
});

describe("toWorkItemView", () => {
  it("flattens fields, converts HTML and resolves parent/tags", () => {
    const view = toWorkItemView(workItemFixture(42) as never, "text");
    expect(view.id).toBe(42);
    expect(view.project).toBe("Alpha");
    expect(view.type).toBe("Bug");
    expect(view.assignedTo).toEqual({ displayName: "Jane Doe", uniqueName: "CORP\\jdoe", id: "u-1" });
    expect(view.tags).toEqual(["hotfix", "backend"]);
    expect(view.parentId).toBe(10);
    expect(view.content.description).toBe("Line one\nLine **two** & three");
    expect(view.content.reproSteps).toBe("- Open app\n- Click");
    expect(view.relations?.[0]).toMatchObject({ name: "Parent", workItemId: 10 });
    expect(view.relations?.[1]).toMatchObject({ name: "Attachment", workItemId: undefined });
    expect(view.webUrl).toContain("/_workitems/edit/42");
  });

  it("keeps HTML when requested", () => {
    const view = toWorkItemView(workItemFixture(1) as never, "html");
    expect(view.content.description).toContain("<div>");
  });

  it("formats identities for assignedTo", () => {
    expect(identityToAssignedToValue({ displayName: "Jane", uniqueName: "CORP\\j", id: "1" })).toBe("Jane <CORP\\j>");
    expect(identityToAssignedToValue({ displayName: "Jane", uniqueName: undefined, id: "1" })).toBe("Jane");
  });
});

describe("html utils", () => {
  it("converts common markup", () => {
    expect(htmlToText("<h2>Title</h2><p>Hello&nbsp;<a href='http://x'>link</a></p><pre>a\n b</pre>")).toBe(
      "## Title\n\nHello [link](http://x)\n\n```\na\n b\n```"
    );
    expect(htmlToText("plain &amp; simple")).toBe("plain & simple");
    expect(htmlToText(undefined)).toBe("");
  });

  it("wraps plain text into HTML but leaves HTML alone", () => {
    expect(textToHtml("a < b\n\nc")).toBe("<div>a &lt; b</div><div>c</div>");
    expect(textToHtml("<b>x</b>")).toBe("<b>x</b>");
  });
});

describe("batch utils", () => {
  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("maps with bounded concurrency and captures rejections in order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n === 4) throw new Error("boom");
      return n * 10;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : "ERR"))).toEqual([10, 20, 30, "ERR", 50, 60]);
  });
});
