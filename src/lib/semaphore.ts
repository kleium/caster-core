/**
 * Simple counting semaphore — analogue of Python's asyncio.Semaphore, used to
 * cap concurrent outbound API calls within a module (matches the
 * `_API_SEMAPHORE = asyncio.Semaphore(N)` pattern in several services).
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    this.available = max;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available <= 0) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.available -= 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.available += 1;
    }
  }
}
