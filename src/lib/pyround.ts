/**
 * Python-compatible round(): round-half-to-even ("banker's rounding"), to match
 * the FastAPI backend's `round(x, n)` output byte-for-byte. JS Math.round is
 * round-half-up, so it diverges on exact ties (e.g. round(2.5) → 2 in Python).
 */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  const m = 10 ** digits;
  const scaled = value * m;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9;
  let rounded: number;
  if (Math.abs(diff - 0.5) < EPS) {
    // Exact tie → round to even.
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / m;
}
