export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  isRetriable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, nextDelayMs: number) => void;
}

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsRetriable(err: unknown): boolean {
  return !(err instanceof PermanentError);
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialDelay = opts.initialDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const isRetriable = opts.isRetriable ?? defaultIsRetriable;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      attempt++;
      if (attempt >= maxAttempts || !isRetriable(err)) throw err;
      const baseDelay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
      const nextDelay = Math.max(0, Math.round(baseDelay + jitter));
      if (opts.onRetry) opts.onRetry(err, attempt, nextDelay);
      await sleep(nextDelay);
    }
  }

  throw lastError;
}
