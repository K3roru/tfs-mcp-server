#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // stdout is reserved for the MCP protocol; diagnostics go to stderr.
      console.error(`[${SERVER_NAME}] configuration error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  console.error(
    `[${SERVER_NAME} ${SERVER_VERSION}] connected via stdio -> ${config.baseUrl}` +
      (config.defaultProject ? ` (default project: ${config.defaultProject})` : "")
  );
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err);
  process.exit(1);
});
