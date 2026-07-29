/**
 * Python truthiness / dict.get / `or` semantics — shared across service ports.
 *
 * JS `??`/`||` don't match Python: `x or y` falls through on any falsy x, and
 * dict.get(k, default) returns a stored None rather than the default (the
 * default applies ONLY when the key is absent). Replicating both is required
 * for byte/semantic parity with the FastAPI backend.
 */
export function pyTruthy(v: unknown): boolean {
  if (v == null || v === 0 || v === '' || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** dict.get(key, default): present-null returns null; absent returns default. */
export function pyGet(obj: Record<string, unknown>, key: string, dflt: unknown = undefined): unknown {
  return key in obj ? obj[key] : dflt;
}

/** Python `a or b or … or z`: first truthy value, else the last value verbatim. */
export function pyOr(...vals: unknown[]): unknown {
  for (let i = 0; i < vals.length - 1; i += 1) {
    if (pyTruthy(vals[i])) return vals[i];
  }
  return vals[vals.length - 1];
}
