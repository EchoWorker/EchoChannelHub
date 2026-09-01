/**
 * outbound-queue.ts — serial, paced, auto-retrying delivery queue.
 *
 * Why this exists: WeChat rate-limits a bot to ~30 msgs/min per session and
 * silently rejects bursts (HTTP 200 + `ret:-2`). Firing a turn's many text
 * segments concurrently (as the old code did) blows past the ceiling and loses
 * messages. This queue serializes every outbound send, paces them with a
 * minimum interval, and on a *retryable* failure (rate limit) backs off and
 * retries instead of dropping. Exhausted retries / non-retryable errors are
 * logged loudly — never swallowed.
 *
 * The queue is deliberately WeChat-agnostic (tasks are opaque `() => Promise`)
 * so it can be unit-tested with a fake clock and arbitrary failing tasks.
 */

export type OutboundQueueOptions = {
  /** Minimum spacing between the *start* of consecutive sends (ms). */
  minIntervalMs?: number;
  /** Max retry attempts for a retryable failure before giving up. */
  maxRetries?: number;
  /** Base backoff for the first retry (ms); doubles each attempt. */
  backoffBaseMs?: number;
  /** Upper cap for backoff (ms). */
  backoffCapMs?: number;
  /** Classifies an error as retryable (e.g. rate limited). Default: never. */
  isRetryable?: (err: unknown) => boolean;
  /** Loud failure sink for give-up / non-retryable errors. */
  onError?: (message: string) => void;
  /** Maximum queued tasks (not counting the in-flight task). Excess is dropped loudly. */
  maxPending?: number;
  /** Called when a task cannot be queued because maxPending is reached. */
  onDrop?: (message: string) => void;
  /** Injectable sleep (tests pass a fake clock). Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests pass a fake clock). Default: Date.now. */
  now?: () => number;
};

type Task = {
  run: () => Promise<void>;
  /** Short label for diagnostics in logs. */
  label: string;
};

const DEFAULT_MIN_INTERVAL_MS = 1_500;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_BASE_MS = 3_000;
const DEFAULT_BACKOFF_CAP_MS = 30_000;
const DEFAULT_MAX_PENDING = 100;

function realSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OutboundQueue {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly isRetryable: (err: unknown) => boolean;
  private readonly onError: (message: string) => void;
  private readonly maxPending: number;
  private readonly onDrop: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private readonly queue: Task[] = [];
  private draining = false;
  private stopped = false;
  /** Whether any send has started yet (gates the first-send no-wait case). */
  private hasStarted = false;
  /** Timestamp (ms) at which the last send *started*; gates pacing. */
  private lastStartTs = 0;
  /** Resolves when the queue has fully drained (for tests / graceful stop). */
  private idleWaiters: Array<() => void> = [];

  constructor(opts: OutboundQueueOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.isRetryable = opts.isRetryable ?? (() => false);
    this.onError = opts.onError ?? (() => {});
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this.onDrop = opts.onDrop ?? this.onError;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Enqueue a send. Returns immediately; delivery happens in the drain loop. */
  enqueue(run: () => Promise<void>, label = "send"): void {
    if (this.stopped) return;
    if (this.queue.length >= this.maxPending) {
      this.onDrop(`outbound-queue: ${label} dropped because ${this.maxPending} tasks are already pending`);
      return;
    }
    this.queue.push({ run, label });
    void this.drain();
  }

  /** Stop draining; in-flight task may finish but no new tasks start. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.resolveIdle();
  }

  /** Number of tasks still queued (not counting one in flight). */
  get pending(): number {
    return this.queue.length;
  }

  /** Resolves when the queue is empty and not draining. Useful in tests. */
  async onIdle(): Promise<void> {
    if (!this.draining && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const task = this.queue.shift()!;
        await this.pace();
        this.hasStarted = true;
        this.lastStartTs = this.now();
        await this.runWithRetry(task);
      }
    } finally {
      this.draining = false;
      if (this.queue.length === 0) this.resolveIdle();
    }
  }

  /** Sleep until at least `minIntervalMs` has passed since the last send start. */
  private async pace(): Promise<void> {
    if (!this.hasStarted) return; // first send: no wait
    const elapsed = this.now() - this.lastStartTs;
    const wait = this.minIntervalMs - elapsed;
    if (wait > 0) await this.sleep(wait);
  }

  private async runWithRetry(task: Task): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) return;
      try {
        await task.run();
        return;
      } catch (err) {
        if (!this.isRetryable(err)) {
          this.onError(`outbound-queue: ${task.label} failed (non-retryable), dropping: ${String(err)}`);
          return;
        }
        if (attempt >= this.maxRetries) {
          this.onError(
            `outbound-queue: ${task.label} gave up after ${this.maxRetries} retries, dropping: ${String(err)}`,
          );
          return;
        }
        const backoff = Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffCapMs);
        await this.sleep(backoff);
      }
    }
  }
}
