/**
 * Server configuration, loaded from environment variables.
 *
 *  TFS_BASE_URL          Collection URL, e.g. https://tfs.corp.local/tfs/DefaultCollection  (required)
 *  TFS_PAT               Personal access token                                              (required)
 *  TFS_DEFAULT_PROJECT   Default project used when a tool call omits `project`              (optional)
 *  TFS_API_VERSION       REST API version, default "6.0"                                    (optional)
 *  TFS_BATCH_CONCURRENCY Max parallel requests for fan-out batch tools, default 5           (optional)
 *  TFS_INSECURE_TLS      "1"/"true" to skip TLS verification (self-signed on-prem certs)    (optional)
 */
export interface TfsConfig {
  baseUrl: string;
  pat: string;
  defaultProject: string | undefined;
  apiVersion: string;
  batchConcurrency: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TfsConfig {
  const baseUrlRaw = env.TFS_BASE_URL?.trim();
  const pat = env.TFS_PAT?.trim();

  if (!baseUrlRaw) {
    throw new ConfigError(
      "TFS_BASE_URL is required (collection URL, e.g. https://tfs.corp.local/tfs/DefaultCollection)"
    );
  }
  if (!pat) {
    throw new ConfigError("TFS_PAT is required (personal access token)");
  }

  let baseUrl: string;
  try {
    const url = new URL(baseUrlRaw);
    // normalise: strip trailing slashes
    url.pathname = url.pathname.replace(/\/+$/, "");
    baseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw new ConfigError(`TFS_BASE_URL is not a valid URL: ${baseUrlRaw}`);
  }

  const concurrencyRaw = env.TFS_BATCH_CONCURRENCY?.trim();
  let batchConcurrency = 5;
  if (concurrencyRaw) {
    const n = Number.parseInt(concurrencyRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      throw new ConfigError("TFS_BATCH_CONCURRENCY must be an integer between 1 and 50");
    }
    batchConcurrency = n;
  }

  const insecure = env.TFS_INSECURE_TLS?.trim().toLowerCase();
  if (insecure === "1" || insecure === "true") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const defaultProject = env.TFS_DEFAULT_PROJECT?.trim();

  return {
    baseUrl,
    pat,
    defaultProject: defaultProject ? defaultProject : undefined,
    apiVersion: env.TFS_API_VERSION?.trim() || "6.0",
    batchConcurrency,
  };
}

/**
 * Resolve the project for a call: explicit argument wins, then TFS_DEFAULT_PROJECT.
 * Throws a descriptive error when a project is required but none is available.
 */
export function resolveProject(
  config: Pick<TfsConfig, "defaultProject">,
  explicit: string | undefined,
  required: true
): string;
export function resolveProject(
  config: Pick<TfsConfig, "defaultProject">,
  explicit: string | undefined,
  required?: false
): string | undefined;
export function resolveProject(
  config: Pick<TfsConfig, "defaultProject">,
  explicit: string | undefined,
  required = false
): string | undefined {
  const value = explicit?.trim() || config.defaultProject;
  if (!value && required) {
    throw new ConfigError(
      "A project is required for this call. Pass the `project` argument or set TFS_DEFAULT_PROJECT."
    );
  }
  return value;
}
