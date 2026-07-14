import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_JOB_POLL_ATTEMPTS,
  TERMINAL_BULK_STATUSES,
  fetchAndParseBulkResults,
  fetchBulkOperationState,
  runBulkMutation,
  splitIntoBatches,
  stagedUpload,
} from '../src/services/shopifyBulk';
import type { ShopifyClient } from '../src/services/shopifyClient';

// ─────────────────────────────────────────────────────────────────────────────
// CHARACTERIZATION TESTS for the Shopify bulk engine.
//
// These pin CURRENT behavior, warts and all. They exist so that extracting the
// shared bulk-op runner (which today is a poll loop copy-pasted across four
// services) can be proven to change nothing. If one of these goes red during
// that refactor, the refactor changed behavior — that is the whole point.
//
// Do not "fix" a surprising assertion here. If the behavior is wrong, change it
// deliberately in its own commit and update the test in that same commit.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal ShopifyClient stand-in: the engine only ever calls .query(). */
function fakeClient(query: (q: string, v?: unknown) => Promise<unknown>): ShopifyClient {
  return { query } as unknown as ShopifyClient;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('splitIntoBatches', () => {
  // Determinism here is load-bearing: reconcile recomputes a job's exact slice
  // from (batchIndex, batchCount) WITHOUT storing it. If this split ever stops
  // being deterministic, every batch reconcile silently maps results to the
  // wrong source rows.
  it('splits contiguously and gives the remainder to the EARLIEST batches', () => {
    expect(splitIntoBatches([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5], [6, 7]]);
  });

  it('divides evenly when it can', () => {
    expect(splitIntoBatches([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('pads with empty batches when n exceeds the item count', () => {
    expect(splitIntoBatches([1], 3)).toEqual([[1], [], []]);
  });

  it('returns n empty batches for an empty input', () => {
    expect(splitIntoBatches([], 2)).toEqual([[], []]);
  });

  it('returns an empty array for n <= 0', () => {
    expect(splitIntoBatches([1, 2], 0)).toEqual([]);
    expect(splitIntoBatches([1, 2], -1)).toEqual([]);
  });

  it('is a pure partition: concatenating the batches reproduces the input in order', () => {
    const items = Array.from({ length: 97 }, (_, i) => i);
    for (const n of [1, 2, 5, 10, 96, 97]) {
      expect(splitIntoBatches(items, n).flat()).toEqual(items);
    }
  });
});

describe('runBulkMutation', () => {
  it('returns the bulk operation id on success', async () => {
    const client = fakeClient(async () => ({
      bulkOperationRunMutation: {
        bulkOperation: { id: 'gid://shopify/BulkOperation/1', status: 'CREATED' },
        userErrors: [],
      },
    }));
    await expect(runBulkMutation(client, 'mutation {}', 'key')).resolves.toBe(
      'gid://shopify/BulkOperation/1',
    );
  });

  // THE PER-SHOP CONCURRENCY PATH. Shopify allows one bulk op per shop. The
  // resume-on-boot logic must key on this: it has to ADOPT the running op
  // rather than re-submit and land here.
  it('maps an "already in progress" userError to the per-shop concurrency message', async () => {
    const client = fakeClient(async () => ({
      bulkOperationRunMutation: {
        bulkOperation: null,
        userErrors: [
          { field: [], message: 'A bulk query operation is already in progress', code: null },
        ],
      },
    }));
    await expect(runBulkMutation(client, 'mutation {}', 'key')).rejects.toThrow(
      /per-shop concurrent limit/i,
    );
  });

  it('matches the in-progress case on the bare phrase "in progress" too', async () => {
    const client = fakeClient(async () => ({
      bulkOperationRunMutation: {
        bulkOperation: null,
        userErrors: [{ field: [], message: 'Operation in progress', code: null }],
      },
    }));
    await expect(runBulkMutation(client, 'm', 'k')).rejects.toThrow(/per-shop concurrent limit/i);
  });

  it('joins other userErrors into a generic failure', async () => {
    const client = fakeClient(async () => ({
      bulkOperationRunMutation: {
        bulkOperation: null,
        userErrors: [
          { field: ['a'], message: 'bad mutation', code: null },
          { field: ['b'], message: 'bad path', code: null },
        ],
      },
    }));
    await expect(runBulkMutation(client, 'm', 'k')).rejects.toThrow(
      'bulkOperationRunMutation failed: bad mutation; bad path',
    );
  });

  it('throws when Shopify returns no operation and no errors', async () => {
    const client = fakeClient(async () => ({
      bulkOperationRunMutation: { bulkOperation: null, userErrors: [] },
    }));
    await expect(runBulkMutation(client, 'm', 'k')).rejects.toThrow(/returned no operation/i);
  });
});

describe('fetchBulkOperationState', () => {
  it('returns the polled node', async () => {
    const node = {
      id: 'gid://1',
      status: 'RUNNING',
      errorCode: null,
      objectCount: '5',
      url: null,
      partialDataUrl: null,
    };
    const client = fakeClient(async () => ({ node }));
    await expect(fetchBulkOperationState(client, 'gid://1')).resolves.toEqual(node);
  });

  it('throws when the operation cannot be found', async () => {
    const client = fakeClient(async () => ({ node: null }));
    await expect(fetchBulkOperationState(client, 'gid://missing')).rejects.toThrow(
      /gid:\/\/missing not found while polling/,
    );
  });
});

describe('fetchAndParseBulkResults', () => {
  const okResponse = (body: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, text: async () => body }) as unknown as Response),
    );

  it('maps 1-based __lineNumber back to lineRefs by position', async () => {
    okResponse(
      [
        JSON.stringify({ __lineNumber: 1, data: { id: 'a' } }),
        JSON.stringify({ __lineNumber: 2, data: { id: 'b' } }),
      ].join('\n'),
    );
    const out = await fetchAndParseBulkResults('http://x', ['rowA', 'rowB'], (l) => ({
      ref: l.ref,
      id: (l.data as { id: string }).id,
    }));
    expect(out).toEqual([
      { ref: 'rowA', id: 'a' },
      { ref: 'rowB', id: 'b' },
    ]);
  });

  // Shopify's __lineNumber is 0- or 1-based depending on context. The engine
  // detects the base from the MINIMUM seen, so both map identically.
  it('maps 0-based __lineNumber identically (base is detected, not assumed)', async () => {
    okResponse(
      [
        JSON.stringify({ __lineNumber: 0, data: { id: 'a' } }),
        JSON.stringify({ __lineNumber: 1, data: { id: 'b' } }),
      ].join('\n'),
    );
    const out = await fetchAndParseBulkResults('http://x', ['rowA', 'rowB'], (l) => l.ref);
    expect(out).toEqual(['rowA', 'rowB']);
  });

  it('falls back to the whole line when there is no `data` key (error lines)', async () => {
    okResponse(JSON.stringify({ __lineNumber: 1, message: 'Email is invalid' }));
    const out = await fetchAndParseBulkResults('http://x', ['rowA'], (l) => ({
      ref: l.ref,
      data: l.data,
      topLevelMessage: (l.raw as { message?: string }).message,
    }));
    expect(out[0].topLevelMessage).toBe('Email is invalid');
    // `data` falls back to the raw line itself.
    expect(out[0].data).toMatchObject({ message: 'Email is invalid' });
  });

  // ⚠ LANDMINE, pinned deliberately. Base detection folds over the MINIMUM
  // __lineNumber seen (shopifyBulk.ts:198-202), which is correct only when the
  // result file starts at the FIRST line. For a PARTIAL result set the minimum
  // is not line 1, so every ref shifts and results are silently attributed to
  // the WRONG source rows. No throw, no warning — just a report that blames the
  // wrong customers.
  //
  // This cannot fire today: `partialDataUrl` is selected in the poll query
  // (shopifyBulk.ts:143) but NEVER parsed. It becomes live the moment anyone
  // wires up partial-result salvage on a FAILED bulk op — which is exactly the
  // thing the async fix will be tempted to reach for. See TODOS.md #3.
  it('MISALIGNS refs when the result file does not start at the first line (partial data)', async () => {
    okResponse(
      [
        JSON.stringify({ __lineNumber: 5, data: { id: 'e' } }),
        JSON.stringify({ __lineNumber: 6, data: { id: 'f' } }),
      ].join('\n'),
    );
    const out = await fetchAndParseBulkResults(
      'http://x',
      ['rowA', 'rowB', 'rowC', 'rowD', 'rowE', 'rowF'],
      (l) => l.ref,
    );
    // CORRECT would be ['rowE', 'rowF'] (lines 5 and 6).
    // ACTUAL is ['rowA', 'rowB'] — base collapses to 5, so line 5 → lineRefs[0].
    expect(out).toEqual(['rowA', 'rowB']);
  });

  it('leaves refs undefined for lines beyond the end of lineRefs', async () => {
    okResponse(
      [
        JSON.stringify({ __lineNumber: 1, data: {} }),
        JSON.stringify({ __lineNumber: 2, data: {} }),
        JSON.stringify({ __lineNumber: 3, data: {} }),
      ].join('\n'),
    );
    const out = await fetchAndParseBulkResults('http://x', ['a'], (l) => l.ref);
    expect(out).toEqual(['a', undefined, undefined]);
  });

  it('ignores blank and whitespace-only lines', async () => {
    okResponse(`\n  \n${JSON.stringify({ __lineNumber: 1, data: {} })}\n\n`);
    const out = await fetchAndParseBulkResults('http://x', ['a'], (l) => l.ref);
    expect(out).toEqual(['a']);
  });

  it('returns [] for an empty result file', async () => {
    okResponse('');
    await expect(fetchAndParseBulkResults('http://x', ['a'], (l) => l.ref)).resolves.toEqual([]);
  });

  it('throws on a non-2xx download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, text: async () => 'nope' }) as unknown as Response),
    );
    await expect(fetchAndParseBulkResults('http://x', [], () => null)).rejects.toThrow(
      /Failed to download bulk results \(HTTP 404\)/,
    );
  });

  // Regression guard: base detection folds with a loop rather than
  // Math.min(...lineNumbers). Spreading 100k+ elements as arguments blows the
  // engine's argument limit ("Maximum call stack size exceeded"). A real import
  // is exactly this size, so this must not regress.
  it('handles a 200k-line result without blowing the call stack', async () => {
    const lines = Array.from({ length: 200_000 }, (_, i) =>
      JSON.stringify({ __lineNumber: i + 1, data: { i } }),
    ).join('\n');
    okResponse(lines);
    const refs = Array.from({ length: 200_000 }, (_, i) => i);
    const out = await fetchAndParseBulkResults('http://x', refs, (l) => l.ref);
    expect(out).toHaveLength(200_000);
    expect(out[0]).toBe(0);
    expect(out[199_999]).toBe(199_999);
  });
});

describe('stagedUpload', () => {
  it('POSTs the JSONL to the staged target and returns the "key" parameter', async () => {
    const postSpy = vi.fn(async () => ({ status: 204, text: async () => '' }) as unknown as Response);
    vi.stubGlobal('fetch', postSpy);

    const client = fakeClient(async () => ({
      stagedUploadsCreate: {
        stagedTargets: [
          {
            url: 'https://storage.example/upload',
            resourceUrl: 'https://storage.example/r',
            parameters: [
              { name: 'key', value: 'tmp/bulk-123.jsonl' },
              { name: 'policy', value: 'abc' },
            ],
          },
        ],
        userErrors: [],
      },
    }));

    await expect(stagedUpload(client, '{"a":1}', 'f.jsonl')).resolves.toBe('tmp/bulk-123.jsonl');
    expect(postSpy).toHaveBeenCalledWith(
      'https://storage.example/upload',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when stagedUploadsCreate returns userErrors', async () => {
    const client = fakeClient(async () => ({
      stagedUploadsCreate: {
        stagedTargets: [],
        userErrors: [{ field: [], message: 'denied' }],
      },
    }));
    await expect(stagedUpload(client, '{}')).rejects.toThrow('stagedUploadsCreate failed: denied');
  });

  it('throws when no staged target comes back', async () => {
    const client = fakeClient(async () => ({
      stagedUploadsCreate: { stagedTargets: [], userErrors: [] },
    }));
    await expect(stagedUpload(client, '{}')).rejects.toThrow(/returned no target/i);
  });

  it('throws when the upload POST fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 403, text: async () => 'forbidden' }) as unknown as Response),
    );
    const client = fakeClient(async () => ({
      stagedUploadsCreate: {
        stagedTargets: [
          { url: 'https://s/u', resourceUrl: 'r', parameters: [{ name: 'key', value: 'k' }] },
        ],
        userErrors: [],
      },
    }));
    await expect(stagedUpload(client, '{}')).rejects.toThrow(
      /Staged upload POST failed \(HTTP 403\)/,
    );
  });

  it('throws when the staged target has no "key" parameter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 204, text: async () => '' }) as unknown as Response),
    );
    const client = fakeClient(async () => ({
      stagedUploadsCreate: {
        stagedTargets: [
          { url: 'https://s/u', resourceUrl: 'r', parameters: [{ name: 'policy', value: 'p' }] },
        ],
        userErrors: [],
      },
    }));
    await expect(stagedUpload(client, '{}')).rejects.toThrow(/missing "key" parameter/);
  });
});

describe('shared constants (the refactor must not redefine these)', () => {
  it('pins the terminal bulk statuses', () => {
    expect(TERMINAL_BULK_STATUSES).toEqual(['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED']);
  });

  it('pins the stuck-job poll bound', () => {
    expect(MAX_JOB_POLL_ATTEMPTS).toBe(300);
  });
});
