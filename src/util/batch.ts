import { describeError, isTfsApiError } from "../client.js";

/** Split a list into chunks of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Map over `items` with at most `limit` concurrent invocations of `fn`.
 * Results are returned in input order; rejections are captured per item.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { status: "fulfilled", value: await fn(item, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export interface BatchFailure<K> {
  key: K;
  status: number | undefined;
  message: string;
}

export interface BatchResult<K, S> {
  succeeded: S[];
  failed: BatchFailure<K>[];
  summary: { total: number; ok: number; failed: number };
}

export function createBatchResult<K, S>(): BatchResult<K, S> {
  return { succeeded: [], failed: [], summary: { total: 0, ok: 0, failed: 0 } };
}

export function addSuccess<K, S>(result: BatchResult<K, S>, value: S): void {
  result.succeeded.push(value);
  result.summary.ok++;
  result.summary.total++;
}

export function addFailure<K, S>(result: BatchResult<K, S>, key: K, error: unknown): void;
export function addFailure<K, S>(result: BatchResult<K, S>, key: K, message: string, status?: number): void;
export function addFailure<K, S>(
  result: BatchResult<K, S>,
  key: K,
  errorOrMessage: unknown,
  status?: number
): void {
  let entry: BatchFailure<K>;
  if (typeof errorOrMessage === "string") {
    entry = { key, status, message: errorOrMessage };
  } else if (isTfsApiError(errorOrMessage)) {
    entry = { key, status: errorOrMessage.status, message: describeError(errorOrMessage) };
  } else {
    entry = { key, status: undefined, message: describeError(errorOrMessage) };
  }
  result.failed.push(entry);
  result.summary.failed++;
  result.summary.total++;
}

/** Remove duplicates while preserving order. */
export function uniq<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items));
}
