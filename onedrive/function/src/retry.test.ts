import { retryWithBackoff, PermanentError } from "./retry";

describe("retryWithBackoff", () => {
  it("returns the result on the first successful attempt", async () => {
    const fn = jest.fn().mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until the function eventually succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValueOnce("recovered");

    const onRetry = jest.fn();
    const result = await retryWithBackoff(fn, { initialDelayMs: 1, onRetry });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("throws the last error after maxAttempts retriable failures", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("still broken"));
    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 1 }),
    ).rejects.toThrow("still broken");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry PermanentError", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new PermanentError("nope"));
    await expect(retryWithBackoff(fn, { initialDelayMs: 1 })).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects a custom isRetriable predicate", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("retry me"))
      .mockRejectedValueOnce(new Error("STOP"));

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 1,
        isRetriable: (err) => err instanceof Error && err.message !== "STOP",
      }),
    ).rejects.toThrow("STOP");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("caps backoff at maxDelayMs", async () => {
    const delays: number[] = [];
    const fn = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 4,
        initialDelayMs: 1000,
        maxDelayMs: 1500,
        onRetry: (_e, _a, d) => delays.push(d),
      }),
    ).rejects.toThrow();
    // All recorded delays should respect the cap (+25% jitter).
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(1500 + 1500 * 0.25);
    }
  });
});
