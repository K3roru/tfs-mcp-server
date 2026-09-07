# tfs-mcp-server

MCP server (stdio) for **Microsoft TFS / Azure DevOps Server** using REST API **6.0**.
Gives an AI agent tools for work items, Git repository files and identity lookup.
Work items and repositories may live in different team projects: every tool accepts an
optional `project` argument that overrides the configured default.

## Requirements

- Node.js 20+
- A TFS / Azure DevOps Server collection reachable over HTTPS
- A Personal Access Token with scopes: Work Items (read & write), Code (read), Identity (read)

## Install & build

```bash
npm install
npm run build        # -> dist/index.js
npm test             # vitest (all TFS calls are mocked)
```

## Configuration (environment variables)

| Variable | Required | Description |
| --- | --- | --- |
| `TFS_BASE_URL` | yes | Collection URL, e.g. `https://tfs.corp.local/tfs/DefaultCollection` |
| `TFS_PAT` | yes | Personal access token (sent as Basic auth) |
| `TFS_DEFAULT_PROJECT` | no | Project used when a call omits `project` |
| `TFS_API_VERSION` | no | Default `6.0` |
| `TFS_BATCH_CONCURRENCY` | no | Parallelism for fan-out batch tools (default `5`) |
| `TFS_INSECURE_TLS` | no | `true` to accept self-signed certificates |

See [.env.example](.env.example).

### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "tfs": {
      "command": "node",
      "args": ["/absolute/path/to/tfs-mcp-server/dist/index.js"],
      "env": {
        "TFS_BASE_URL": "https://tfs.corp.local/tfs/DefaultCollection",
        "TFS_PAT": "<your PAT>",
        "TFS_DEFAULT_PROJECT": "MyProject"
      }
    }
  }
}
```

Claude Desktop uses the same shape in `claude_desktop_config.json`.

### Interactive testing

```bash
TFS_BASE_URL=... TFS_PAT=... npm run inspect   # opens the MCP Inspector against dist/index.js
```

## Tools

All tools return a short text summary plus a JSON payload (`structuredContent`).
Errors are returned as tool errors with the TFS message, HTTP status and request URL.

### Work items

| Tool | Purpose |
| --- | --- |
| `get_work_item` | Metadata, rich-text content (Description / Repro Steps / Acceptance Criteria, HTML converted to text by default), relations, optional comments |
| `get_work_items` | Same for many ids in one call (`workitemsbatch`, 200 ids per request); missing ids listed in `failed` |
| `get_work_item_comments` | Paged comments (ids needed for updates) |
| `update_work_item` | JSON-Patch update. **`state` and `assignedTo` are mandatory**; optional title, description, tags, area/iteration, priority, arbitrary `fields`, `comment`, `expectedRev`, `bypassRules`, `validateOnly` |
| `update_work_items` | Same update applied to many ids via `wit/$batch` (falls back to parallel PATCH if `$batch` is unavailable); per-item results |
| `add_work_item_comment` | Add a comment (plain text is wrapped into HTML) |
| `add_comment_to_work_items` | Same comment on many work items (bounded-concurrency fan-out) |
| `update_work_item_comment` | Replace the text of an existing comment |
| `get_query` | Saved query by GUID or path: WIQL, columns, type; folders list children |
| `run_query` | Execute a saved query; optional `extraWhere` (raw WIQL condition AND-ed into the query) |
| `run_wiql` | Execute an arbitrary WIQL string as-is |

`assignedTo` accepts a display name, `DOMAIN\user`, an e-mail, `Display Name <DOMAIN\user>`, or `""` to unassign.
Use `get_current_identity` / `search_identities` to obtain valid values.

### Files (Git)

| Tool | Purpose |
| --- | --- |
| `list_repositories` | Repositories of a project (or the whole collection) |
| `get_file_content` | File content at `branch` / `commit` / `tag` (default: repo default branch). Text inline, binaries base64. A missing file produces a verbose diagnosis: does the repository exist, does the branch exist (with a branch list), does the parent directory exist and what does it contain, plus "did you mean" suggestions |
| `get_files_content` | Several files from one repo/version in one call (`itemsbatch` + parallel content download), per-path diagnostics |
| `list_directory` | Entries under a directory (one level or recursive) with object ids, content type and latest commit |

### Identity

| Tool | Purpose |
| --- | --- |
| `get_current_identity` | Who the PAT belongs to (`connectionData`, enriched via the identities API): id, display name, account, e-mail and a ready-to-use `assignedToValue` |
| `search_identities` | Find users/groups by name, account or e-mail |

## Example flows

```text
get_current_identity                         -> assignedToValue = "Jane Doe <CORP\\jdoe>"
run_query { queryId: "Shared Queries/Team/Triage", extraWhere: "[System.Tags] CONTAINS 'hotfix'" }
update_work_items { ids: [...], state: "Active", assignedTo: "Jane Doe <CORP\\jdoe>" }
add_comment_to_work_items { ids: [...], text: "Picked up in sprint 12" }
get_files_content { project: "Infra", repository: "tools", branch: "develop", paths: ["/README.md", "/src/main.ts"] }
```

## Notes on TFS API versions

- Work item, WIQL, Git and repository endpoints use `api-version=6.0`.
- The work item **comments** API only exists as a preview in 6.0; the server uses `6.0-preview.3`.
- `connectionData` (`6.0-preview`) and `identities` (`6.0-preview.1`) are collection-scoped; the identities call is optional and failures are tolerated.
- `wit/$batch` is used for bulk updates; if a server rejects it (404/405/400) the tool transparently falls back to individual PATCH requests.
- If TFS answers with an HTML sign-in page or HTTP 203 instead of JSON, the PAT is invalid or the base URL does not point at a collection; the error message says so.

## Project layout

```
src/
  index.ts            stdio entrypoint
  server.ts           McpServer factory + tool registration
  config.ts           env parsing, project resolution
  client.ts           REST client (Basic PAT auth, URL builder, TfsApiError)
  services/           TFS API wrappers (workitems, git, identity)
  tools/              MCP tool definitions (zod schemas)
  util/               html->text, batch helpers, tool result helpers
tests/                vitest suites with a mocked fetch
```
