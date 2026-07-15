import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BULK_POLL_INTERVAL_MS,
  MAX_BULK_POLL_ATTEMPTS,
  MAX_JOB_POLL_ATTEMPTS,
  TERMINAL_BULK_STATUSES,
  awaitBulkOperationResultUrl,
  bulkDeleteByIds,
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
    const out = await fetchAndParseBulkResults(
      'http://x',
      ['rowA', 'rowB'],
      { kind: 'complete' },
      (l) => ({ ref: l.ref, id: (l.data as { id: string }).id }),
    );
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
    const out = await fetchAndParseBulkResults(
      'http://x',
      ['rowA', 'rowB'],
      { kind: 'complete' },
      (l) => l.ref,
    );
    expect(out).toEqual(['rowA', 'rowB']);
  });

  it('falls back to the whole line when there is no `data` key (error lines)', async () => {
    okResponse(JSON.stringify({ __lineNumber: 1, message: 'Email is invalid' }));
    const out = await fetchAndParseBulkResults(
      'http://x',
      ['rowA'],
      { kind: 'complete' },
      (l) => ({
        ref: l.ref,
        data: l.data,
        topLevelMessage: (l.raw as { message?: string }).message,
      }),
    );
    expect(out[0].topLevelMessage).toBe('Email is invalid');
    // `data` falls back to the raw line itself.
    expect(out[0].data).toMatchObject({ message: 'Email is invalid' });
  });

  it('maps a partial result with an explicit base instead of shifting refs', async () => {
    okResponse(
      [
        JSON.stringify({ __lineNumber: 5, data: { id: 'e' } }),
        JSON.stringify({ __lineNumber: 6, data: { id: 'f' } }),
      ].join('\n'),
    );
    const out = await fetchAndParseBulkResults(
      'http://x',
      ['rowA', 'rowB', 'rowC', 'rowD', 'rowE', 'rowF'],
      { kind: 'partial', lineNumberBase: 1 },
      (l) => l.ref,
    );
    expect(out).toEqual(['rowE', 'rowF']);
  });

  it('refuses to treat a partial-looking file as a completed result', async () => {
    okResponse(JSON.stringify({ __lineNumber: 5, data: {} }));
    await expect(
      fetchAndParseBulkResults('http://x', ['a', 'b', 'c', 'd', 'e'], { kind: 'complete' }, (l) => l.ref),
    ).rejects.toThrow(/may be partial data/i);
  });

  it('throws when a result line is beyond the submitted refs', async () => {
    okResponse(
      [
        JSON.stringify({ __lineNumber: 1, data: {} }),
        JSON.stringify({ __lineNumber: 2, data: {} }),
        JSON.stringify({ __lineNumber: 3, data: {} }),
      ].join('\n'),
    );
    await expect(
      fetchAndParseBulkResults('http://x', ['a'], { kind: 'complete' }, (l) => l.ref),
    ).rejects.toThrow(/does not map/i);
  });

  it('throws when __lineNumber is missing or invalid', async () => {
    okResponse(JSON.stringify({ data: {} }));
    await expect(
      fetchAndParseBulkResults('http://x', ['a'], { kind: 'complete' }, (l) => l.ref),
    ).rejects.toThrow(/invalid __lineNumber/i);
  });

  it('ignores blank and whitespace-only lines', async () => {
    okResponse(`\n  \n${JSON.stringify({ __lineNumber: 1, data: {} })}\n\n`);
    const out = await fetchAndParseBulkResults(
      'http://x',
      ['a'],
      { kind: 'complete' },
      (l) => l.ref,
    );
    expect(out).toEqual(['a']);
  });

  it('returns [] for an empty result file', async () => {
    okResponse('');
    await expect(
      fetchAndParseBulkResults('http://x', ['a'], { kind: 'complete' }, (l) => l.ref),
    ).resolves.toEqual([]);
  });

  it('throws on a non-2xx download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, text: async () => 'nope' }) as unknown as Response),
    );
    await expect(fetchAndParseBulkResults('http://x', [], { kind: 'complete' }, () => null)).rejects.toThrow(
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
    const out = await fetchAndParseBulkResults(
      'http://x',
      refs,
      { kind: 'complete' },
      (l) => l.ref,
    );
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

describe('awaitBulkOperationResultUrl', () => {
  /** A client whose poll returns each queued state in turn (last one repeats). */
  function pollingClient(states: { status: string; errorCode?: string | null; url?: string | null }[]) {
    let i = 0;
    return fakeClient(async () => {
      const s = states[Math.min(i++, states.length - 1)];
      return {
        node: {
          id: 'gid://1',
          status: s.status,
          errorCode: s.errorCode ?? null,
          objectCount: '1',
          url: s.url ?? null,
          partialDataUrl: null,
        },
      };
    });
  }

  it('returns the result url once the op is COMPLETED', async () => {
    const client = pollingClient([{ status: 'COMPLETED', url: 'https://results/1' }]);
    await expect(awaitBulkOperationResultUrl(client, 'gid://1')).resolves.toBe('https://results/1');
  });

  it('keeps polling while the op is non-terminal, then returns', async () => {
    vi.useFakeTimers();
    const client = pollingClient([
      { status: 'RUNNING' },
      { status: 'RUNNING' },
      { status: 'COMPLETED', url: 'https://results/2' },
    ]);
    const promise = awaitBulkOperationResultUrl(client, 'gid://1');
    await vi.advanceTimersByTimeAsync(BULK_POLL_INTERVAL_MS * 3);
    await expect(promise).resolves.toBe('https://results/2');
    vi.useRealTimers();
  });

  // The 300s in-request block. This is exactly why the cleanup routes cannot
  // work hosted: a platform proxy gives up around 100s.
  it('throws after MAX_BULK_POLL_ATTEMPTS if the op never goes terminal', async () => {
    vi.useFakeTimers();
    const client = pollingClient([{ status: 'RUNNING' }]);
    const promise = awaitBulkOperationResultUrl(client, 'gid://1');
    const caught = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(BULK_POLL_INTERVAL_MS * (MAX_BULK_POLL_ATTEMPTS + 2));
    const err = await caught;
    expect((err as Error).message).toMatch(/did not finish within 300s/);
    expect((err as Error).message).toMatch(/re-run cleanup shortly/);
    vi.useRealTimers();
  });

  it('throws with the status and errorCode when the op ends non-COMPLETED', async () => {
    const client = pollingClient([{ status: 'FAILED', errorCode: 'INTERNAL_SERVER_ERROR' }]);
    await expect(awaitBulkOperationResultUrl(client, 'gid://1')).rejects.toThrow(
      'Bulk delete FAILED (INTERNAL_SERVER_ERROR).',
    );
  });

  it('omits the parenthetical when there is no errorCode', async () => {
    const client = pollingClient([{ status: 'CANCELED' }]);
    await expect(awaitBulkOperationResultUrl(client, 'gid://1')).rejects.toThrow(
      'Bulk delete CANCELED.',
    );
  });

  it('throws when the op COMPLETED but Shopify returned no result file', async () => {
    const client = pollingClient([{ status: 'COMPLETED', url: null }]);
    await expect(awaitBulkOperationResultUrl(client, 'gid://1')).rejects.toThrow(
      'Bulk delete completed but Shopify returned no result file.',
    );
  });

  it('uses the caller-supplied label in error text', async () => {
    const client = pollingClient([{ status: 'FAILED' }]);
    await expect(awaitBulkOperationResultUrl(client, 'gid://1', 'Bulk import')).rejects.toThrow(
      'Bulk import FAILED.',
    );
  });
});

describe('bulkDeleteByIds', () => {
  const spec = {
    mutation: 'mutation productDelete {}',
    filename: 'bulk_product_delete.jsonl',
    payloadKey: 'productDelete',
    deletedIdKey: 'deletedProductId',
  };

  /** Wire up: stagedUploadsCreate → bulkOperationRunMutation → poll(COMPLETED) → results. */
  function deleteClient() {
    return fakeClient(async (q: string) => {
      if (q.includes('stagedUploadsCreate')) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [
              { url: 'https://s/u', resourceUrl: 'r', parameters: [{ name: 'key', value: 'k' }] },
            ],
            userErrors: [],
          },
        };
      }
      if (q.includes('bulkOperationRunMutation')) {
        return {
          bulkOperationRunMutation: {
            bulkOperation: { id: 'gid://op', status: 'CREATED' },
            userErrors: [],
          },
        };
      }
      return {
        node: {
          id: 'gid://op',
          status: 'COMPLETED',
          errorCode: null,
          objectCount: '2',
          url: 'https://results',
          partialDataUrl: null,
        },
      };
    });
  }

  function stubResults(body: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('https://results')
          ? ({ status: 200, text: async () => body } as unknown as Response)
          : ({ status: 204, text: async () => '' } as unknown as Response),
      ),
    );
  }

  it('counts successful deletes and maps failures back to their source id', async () => {
    stubResults(
      [
        JSON.stringify({
          __lineNumber: 1,
          data: { productDelete: { deletedProductId: 'gid://p1', userErrors: [] } },
        }),
        JSON.stringify({
          __lineNumber: 2,
          data: {
            productDelete: {
              deletedProductId: null,
              userErrors: [{ message: 'Product is referenced by an order' }],
            },
          },
        }),
      ].join('\n'),
    );

    const out = await bulkDeleteByIds(deleteClient(), ['gid://p1', 'gid://p2'], spec);

    expect(out.deleted).toBe(1);
    expect(out.errors).toEqual([
      { id: 'gid://p2', message: 'Product is referenced by an order' },
    ]);
  });

  it('treats a line with no mutation payload as a top-level error', async () => {
    stubResults(JSON.stringify({ __lineNumber: 1, message: 'Invalid global id' }));
    const out = await bulkDeleteByIds(deleteClient(), ['gid://bad'], spec);
    expect(out.deleted).toBe(0);
    expect(out.errors).toEqual([{ id: 'gid://bad', message: 'Invalid global id' }]);
  });

  it('falls back to a generic message when Shopify rejects with no userErrors', async () => {
    stubResults(
      JSON.stringify({
        __lineNumber: 1,
        data: { productDelete: { deletedProductId: null, userErrors: [] } },
      }),
    );
    const out = await bulkDeleteByIds(deleteClient(), ['gid://p1'], spec);
    expect(out.errors).toEqual([{ id: 'gid://p1', message: 'Delete rejected by Shopify.' }]);
  });

  it('is entity-agnostic: the same engine folds customerDelete payloads', async () => {
    stubResults(
      JSON.stringify({
        __lineNumber: 1,
        data: { customerDelete: { deletedCustomerId: 'gid://c1', userErrors: [] } },
      }),
    );
    const out = await bulkDeleteByIds(deleteClient(), ['gid://c1'], {
      mutation: 'mutation customerDelete {}',
      filename: 'bulk_customer_delete.jsonl',
      payloadKey: 'customerDelete',
      deletedIdKey: 'deletedCustomerId',
    });
    expect(out).toEqual({ deleted: 1, errors: [] });
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
