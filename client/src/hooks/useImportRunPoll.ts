import { useEffect, useRef, useState } from 'react';

// Shopify bulk-op statuses that mean the import has stopped advancing.
export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED'];
export const isTerminal = (status: string): boolean => TERMINAL_STATUSES.includes(status);

const POLL_INTERVAL_MS = 3000;
// Back off after failed polls, but never wait longer than this between tries.
const MAX_BACKOFF_MS = 30000;

interface Options<T> {
  /** The run being shown, or null. Polling runs while its status is non-terminal. */
  runId: string | undefined;
  status: string | undefined;
  fetchFeedback: (importRunId: string) => Promise<T>;
  onUpdate: (next: T) => void;
  /** Called once, right after the update that made the run terminal. */
  onTerminal: () => void;
  describeError: (err: unknown) => string;
}

/**
 * Reconcile-on-poll for an import run — shared by the customer ImportPanel and
 * the product StoreImportControls (they are twins).
 *
 * A failed poll does NOT end polling. It used to: the catch set an error and
 * never rescheduled, and since the run id and status had not changed nothing
 * restarted it, so one 502 or a server restart left "Importing… (running in
 * Shopify)" and disabled controls until a reload. Now a failure is shown as
 * pollError and retried with backoff; the next good answer clears it.
 *
 * Polling stops on unmount and whenever the run switches (new id or status).
 */
export function useImportRunPoll<T extends { status: string }>({
  runId,
  status,
  fetchFeedback,
  onUpdate,
  onTerminal,
  describeError,
}: Options<T>): string {
  const [pollError, setPollError] = useState('');
  // Callbacks change identity every render; read the latest without restarting.
  const latest = useRef({ fetchFeedback, onUpdate, onTerminal, describeError });
  latest.current = { fetchFeedback, onUpdate, onTerminal, describeError };

  useEffect(() => {
    setPollError('');
    if (!runId || !status || isTerminal(status)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const poll = async (): Promise<void> => {
      try {
        const next = await latest.current.fetchFeedback(runId);
        if (!active) return;
        failures = 0;
        setPollError('');
        latest.current.onUpdate(next);
        if (isTerminal(next.status)) {
          latest.current.onTerminal();
          return;
        }
      } catch (err) {
        if (!active) return;
        failures++;
        setPollError(
          `Could not check the import status (${latest.current.describeError(err)}). ` +
            'Retrying — the import keeps running in Shopify meanwhile.',
        );
      }
      // Schedule only after this request finishes. setInterval could overlap
      // slow Shopify reconciliations and advance the same run concurrently.
      const delay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
      timer = setTimeout(poll, delay);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, status]);

  return pollError;
}
