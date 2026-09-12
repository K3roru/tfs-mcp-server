import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TfsClient } from "./client.js";
import type { TfsConfig } from "./config.js";
import type { ToolContext } from "./context.js";
import { registerFileTools } from "./tools/files.js";
import { registerGitWriteTools } from "./tools/gitwrite.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerWorkItemTools } from "./tools/workitems.js";

export const SERVER_NAME = "tfs-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Build a fully configured McpServer (transport-agnostic, so tests can drive it in-memory). */
export function createServer(config: TfsConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const client = new TfsClient(config, fetchImpl);
  const ctx: ToolContext = { client, config };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Tools for Microsoft TFS / Azure DevOps Server at ${config.baseUrl} (REST API ${config.apiVersion}). ` +
        (config.defaultProject
          ? `Default project: "${config.defaultProject}". `
          : "No default project is configured; pass `project` where required. ") +
        "Work items and Git repositories may live in different projects - every tool accepts an optional `project` override. " +
        "Use get_current_identity to learn the PAT owner's `assignedToValue`, and search_identities to resolve other people. " +
        "Git write tools (create_branch, commit_file_changes, create_pull_request, or the one-shot create_branch_commit_and_pull_request) " +
        "let you branch, commit file changes and open work-item-linked pull requests.",
    }
  );

  registerWorkItemTools(server, ctx);
  registerFileTools(server, ctx);
  registerGitWriteTools(server, ctx);
  registerIdentityTools(server, ctx);
  return server;
}
