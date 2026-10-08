import { describe, expect, it, vi } from 'vitest';
import { singleFlight } from '../src/utils/singleFlight';

// The boot-time sweeps tick every 60s. A sweep slower than its tick must not be
// started a second time on top of itself.

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('skips a tick while the previous run is still in flight', async () => {
    const gate = deferred();
    const job = vi.fn(() => gate.promise);
    const tick = singleFlight(job, () => undefined);

    const first = tick();
    await tick(); // fires mid-run: skipped
    await tick();
    expect(job).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first;

    await tick(); // the previous run is done: runs again
    expect(job).toHaveBeenCalledTimes(2);
  });

  it('reports a failure and runs again on the next tick', async () => {
    const onError = vi.fn();
    const job = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('store unreachable'))
      .mockResolvedValueOnce(undefined);
    const tick = singleFlight(job, onError);

    await expect(tick()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'store unreachable' }));

    await tick();
    expect(job).toHaveBeenCalledTimes(2);
  });
});
