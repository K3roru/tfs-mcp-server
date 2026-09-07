import type { TfsClient } from "./client.js";
import type { TfsConfig } from "./config.js";

/** Shared dependencies handed to every tool module. */
export interface ToolContext {
  client: TfsClient;
  config: TfsConfig;
}
