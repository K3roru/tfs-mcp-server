import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { getConnectionData, readIdentities, searchIdentities, toIdentityView, type IdentityView } from "../services/identity.js";
import { guard, ok } from "../util/result.js";

export function registerIdentityTools(server: McpServer, ctx: ToolContext): void {
  const { client, config } = ctx;

  /* ---------------------------------- get_current_identity ---------------------------------- */
  server.registerTool(
    "get_current_identity",
    {
      title: "Get current identity",
      description:
        "Identify the user behind the configured PAT: id, display name, account (DOMAIN\\\\user or e-mail), descriptor, plus a ready-to-use " +
        "`assignedToValue` for update_work_item(s). Also returns basic server info (deployment type, instance id).",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async () => {
      const cd = await getConnectionData(client);
      const authUser = cd.authenticatedUser;
      if (!authUser?.id) {
        throw new Error("connectionData did not return an authenticated user; the PAT may be invalid.");
      }
      let view: IdentityView = toIdentityView(authUser);
      let enriched = false;
      try {
        const [full] = await readIdentities(client, [authUser.id]);
        if (full) {
          const richer = toIdentityView(full);
          view = {
            ...view,
            ...Object.fromEntries(Object.entries(richer).filter(([, v]) => v !== undefined)),
          } as IdentityView;
          enriched = true;
        }
      } catch {
        /* identities API is optional; connectionData alone is enough */
      }
      const data = {
        user: view,
        authorizedUser:
          cd.authorizedUser && cd.authorizedUser.id !== authUser.id ? toIdentityView(cd.authorizedUser) : undefined,
        server: {
          baseUrl: config.baseUrl,
          deploymentType: cd.deploymentType,
          instanceId: cd.instanceId,
          defaultProject: config.defaultProject,
          apiVersion: config.apiVersion,
        },
        enrichedFromIdentitiesApi: enriched,
      };
      return ok(`Authenticated as ${view.displayName ?? "?"} (${view.uniqueName ?? view.id})`, data);
    })
  );

  /* ---------------------------------- search_identities ---------------------------------- */
  server.registerTool(
    "search_identities",
    {
      title: "Search identities",
      description:
        "Find users or groups by display name, account name or e-mail to obtain a valid `assignedTo` value. " +
        "Returns id, display name, unique account name and `assignedToValue` for each match.",
      inputSchema: {
        query: z.string().min(1).describe("Search text, e.g. 'John', 'DOMAIN\\\\jdoe' or 'john@corp.com'."),
        filter: z
          .enum(["General", "AccountName", "DisplayName", "MailAddress", "LocalGroupName"])
          .default("General")
          .describe("Which identity property to match."),
        includeGroups: z.boolean().default(false).describe("Include groups in the results."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(async ({ query, filter, includeGroups }) => {
      const raw = await searchIdentities(client, query, filter);
      const identities = raw.map(toIdentityView).filter((i) => includeGroups || !i.isGroup);
      return ok(`${identities.length} identities matched '${query}'`, { query, filter, count: identities.length, identities });
    })
  );
}
