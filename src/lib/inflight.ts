/**
 * In-flight request coalescing (single-flight) — port of
 * backend/app/services/inflight.py.
 *
 * When N concurrent callers request the same expensive resource under the same
 * `key`, only ONE runs `fn`; the rest await the same promise. The entry is
 * removed once the promise settles so a fresh call can happen next time.
 */
const _inflight = new Map<string, Promise<unknown>>();

export function coalesce<T>(
  key: string,
  fn: (...args: never[]) => Promise<T>,
  ...args: never[]
): Promise<T> {
  const existing = _inflight.get(key);
  if (existing !== undefined) {
    return existing as Promise<T>;
  }
  const promise = (async () => {
    try {
      return await fn(...args);
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, promise);
  return promise;
}
