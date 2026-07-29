/**
 * Circuit breaker for external API calls — port of
 * backend/app/services/circuit_breaker.py.
 *
 * When an upstream service fails repeatedly the circuit opens and subsequent
 * calls fail fast instead of piling up on a dead endpoint. After a cooldown the
 * circuit half-opens to let a single probe through; success closes it again.
 *
 * Note: JS is single-threaded with cooperative scheduling, so the Python
 * asyncio.Lock around state mutation is unnecessary here — state transitions in
 * _recordFailure/_recordSuccess are synchronous and cannot interleave.
 */

export enum State {
  CLOSED = 'closed', // normal — requests flow through
  OPEN = 'open', // tripped — requests fail fast
  HALF_OPEN = 'half_open', // cooldown elapsed — allow one probe
}

export class CircuitOpenError extends Error {
  readonly serviceName: string;
  constructor(serviceName: string) {
    super(
      `Service '${serviceName}' is temporarily unavailable — ` +
        'too many recent failures. Please try again in a few seconds.',
    );
    this.name = 'CircuitOpenError';
    this.serviceName = serviceName;
  }
}

/** Return true to count the exception toward the threshold. */
export type FailureClassifier = (err: unknown) => boolean;

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeout?: number; // seconds
  halfOpenMax?: number;
  window?: number; // seconds
}

export class CircuitBreaker {
  readonly name: string;
  private readonly failureThreshold: number;
  private readonly recoveryTimeout: number;
  private readonly halfOpenMax: number;
  private readonly window: number;

  private _state: State = State.CLOSED;
  private _failureTimes: number[] = [];
  private _lastFailureTime = 0;
  private _halfOpenCount = 0;

  constructor(name: string, opts: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.recoveryTimeout = opts.recoveryTimeout ?? 30;
    this.halfOpenMax = opts.halfOpenMax ?? 1;
    this.window = opts.window ?? 60;
  }

  /** Current state, transitioning OPEN → HALF_OPEN once recoveryTimeout elapses. */
  get state(): State {
    if (this._state === State.OPEN) {
      if (this._now() - this._lastFailureTime >= this.recoveryTimeout) {
        return State.HALF_OPEN;
      }
    }
    return this._state;
  }

  private _now(): number {
    // Seconds, monotonic (mirrors Python time.monotonic()).
    return performance.now() / 1000;
  }

  /**
   * Execute `fn()` through the breaker. Throws CircuitOpenError when open.
   * `isFailure` classifies errors: return false to let an error propagate
   * without tripping the breaker (e.g. a 404 is not a service outage).
   */
  async call<T>(fn: () => Promise<T>, isFailure?: FailureClassifier): Promise<T> {
    const current = this.state;

    if (current === State.OPEN) {
      throw new CircuitOpenError(this.name);
    }
    if (current === State.HALF_OPEN) {
      if (this._halfOpenCount >= this.halfOpenMax) {
        throw new CircuitOpenError(this.name);
      }
      this._halfOpenCount += 1;
    }

    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (err) {
      if (isFailure === undefined || isFailure(err)) {
        this._recordFailure();
      }
      throw err;
    }
  }

  private _recordFailure(): void {
    const now = this._now();
    this._failureTimes.push(now);
    this._lastFailureTime = now;
    const cutoff = now - this.window;
    this._failureTimes = this._failureTimes.filter((t) => t >= cutoff);
    if (this._failureTimes.length >= this.failureThreshold) {
      if (this._state !== State.OPEN) {
        console.warn(
          `Circuit breaker [${this.name}] OPEN after ${this._failureTimes.length} ` +
            `failures in ${this.window}s window`,
        );
      }
      this._state = State.OPEN;
    }
  }

  private _recordSuccess(): void {
    if (this._state === State.HALF_OPEN || this._state === State.OPEN) {
      console.info(`Circuit breaker [${this.name}] CLOSED (recovered)`);
    }
    this._state = State.CLOSED;
    this._failureTimes = [];
    this._halfOpenCount = 0;
  }

  /** Manually close the breaker (e.g. after a cache clear). */
  reset(): void {
    this._state = State.CLOSED;
    this._failureTimes = [];
    this._halfOpenCount = 0;
  }
}

// ── Shared breaker instances ────────────────────────────────
const _breakers = new Map<string, CircuitBreaker>();

export function getBreaker(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
  let b = _breakers.get(name);
  if (!b) {
    b = new CircuitBreaker(name, opts);
    _breakers.set(name, b);
  }
  return b;
}

// Pre-configured breakers — thresholds copied verbatim from
// circuit_breaker.py:151-155 (10 to survive parallel fan-out bursts).
export const tbaBreaker = getBreaker('The Blue Alliance', {
  failureThreshold: 10,
  recoveryTimeout: 30,
  window: 60,
});
export const frcBreaker = getBreaker('FRC Events API', {
  failureThreshold: 10,
  recoveryTimeout: 60,
  window: 60,
});
export const ftcBreaker = getBreaker('FTC Events API', {
  failureThreshold: 10,
  recoveryTimeout: 60,
  window: 60,
});
export const statboticsBreaker = getBreaker('Statbotics', {
  failureThreshold: 10,
  recoveryTimeout: 60,
  window: 60,
});
export const gatoolBreaker = getBreaker('GATool', {
  failureThreshold: 5,
  recoveryTimeout: 60,
  window: 60,
});
// ftcscout_client.py:21 — higher threshold/tighter window: parallel query
// bursts (team stats, quick stats, opr history) shouldn't trip prematurely.
export const ftcscoutBreaker = getBreaker('FTC Scout', {
  failureThreshold: 20,
  recoveryTimeout: 30,
  window: 30,
});
