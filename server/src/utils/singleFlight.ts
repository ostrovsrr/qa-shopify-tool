/**
 * Wrap a periodic background job so a tick that fires while the previous run is
 * still in flight is SKIPPED, not started alongside it.
 *
 * The boot-time sweeps in index.ts run on setInterval. A sweep that reconciles every
 * RUNNING import against Shopify can easily outlast its 60-second tick when a store
 * is slow — and without a guard the next tick starts a second, concurrent pass over
 * the same rows, which then compete for the same locks and the same Shopify rate
 * budget, and the backlog only grows.
 *
 * Errors go to `onError` and are swallowed: a failed tick must not kill the
 * process, and the next tick simply tries again.
 */
export function singleFlight(
  job: () => Promise<unknown>,
  onError: (err: Error) => void,
): () => Promise<void> {
  let inFlight = false;

  return async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await job();
    } catch (err) {
      onError(err as Error);
    } finally {
      inFlight = false;
    }
  };
}
