import { setTimeout as delay } from "node:timers/promises";

/** Process-local coordination for callers sharing the local inference server. */
export class LocalModelCapacity {
  private foreground = 0;
  private idleSince = -Infinity;
  private background?: AbortController;

  async run<T>(
    background: boolean,
    signal: AbortSignal | undefined,
    request: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!background) {
      this.foreground++;
      this.background?.abort();
      try {
        return await request(signal);
      } finally {
        if (--this.foreground === 0) {
          this.idleSince = Date.now();
        }
      }
    }
    for (;;) {
      signal?.throwIfAborted();
      if (this.foreground || this.background || Date.now() - this.idleSince < 2000) {
        await delay(100, undefined, { signal });
        continue;
      }
      const attempt = new AbortController();
      this.background = attempt;
      const combined = signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal;
      try {
        const result = await request(combined);
        combined.throwIfAborted();
        return result;
      } catch (error) {
        // Retry only preemption; caller cancellation and model failures remain terminal.
        signal?.throwIfAborted();
        if (!attempt.signal.aborted) {
          throw error;
        }
      } finally {
        this.background = undefined;
      }
    }
  }
}

export const localModelCapacity = new LocalModelCapacity();
