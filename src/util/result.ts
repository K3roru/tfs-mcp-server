import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describeError, isTfsApiError } from "../client.js";

/**
 * Build a successful tool result: a short text summary plus the full JSON payload
 * (also echoed as text so clients without structuredContent support still see it).
 */
export function ok(summary: string, data: unknown): CallToolResult {
  const json = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text: summary ? `${summary}\n\n${json}` : json }],
    structuredContent: toStructured(data),
  };
}

/** Build a tool error result with as much diagnostic detail as available. */
export function fail(err: unknown, context?: string): CallToolResult {
  const lines: string[] = [];
  if (context) lines.push(context);
  lines.push(describeError(err));
  const structured: Record<string, unknown> = { error: describeError(err) };
  if (isTfsApiError(err)) {
    structured.status = err.status;
    structured.typeKey = err.typeKey;
    structured.url = err.url;
    if (err.body !== undefined) structured.body = err.body;
  }
  if (context) structured.context = context;
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: structured,
    isError: true,
  };
}

/** Wrap a tool handler so any thrown error becomes a `fail` result instead of a protocol error. */
export function guard<A>(
  fn: (args: A) => Promise<CallToolResult>,
  context?: (args: A) => string
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err, context?.(args));
    }
  };
}

function toStructured(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { result: data };
}
