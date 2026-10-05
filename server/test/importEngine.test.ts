import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BulkOperationNotFoundError,
  BulkResultParseError,
  MAX_IMPORT_RUNTIME_MS,
  bulkLineErrorMessage,
  fetchAndParseBulkResults,
  fetchBulkOperationState,
  resolveLineNumberBase,
  runBulkMutation,
} from '../src/services/shopifyBulk';
import {
  ShopifyApiError,
  ShopifyAuthError,
  ShopifyClient,
  ShopifyConfigError,
  ShopifyOutcomeUnknownError,
} from '../src/services/shopifyClient';
import { classifyReconcileError } from '../src/services/importReconcile';
import { storeLabeller } from '../src/services/importFeedback.service';
import { handlesInOrder, parseProductSetLine } from '../src/services/productImport.service';
import { parseCustomerCreateLine } from '../src/services/shopifyImport.service';
import { groupByHandle } from '../src/services/productCsvParser';
import { normalizeRecord } from '../src/utils/normalize';

// ─────────────────────────────────────────────────────────────────────────────
// THE IMPORT ENGINE'S FAILURE PATHS — the parts that decide what an import
// reports when something goes wrong, for customers and products alike (twins).
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── a non-idempotent submit is never blindly re-sent ─────────────────────────

function realClient(): ShopifyClient {
  return new ShopifyClient({
    id: 'qa1',
    label: 'QA 1',
    shop: 'qa1.example.com',
    apiVersion: '2026-01',
    adminToken: 'test-token',
  });
}

const json = (status: number, body: unknown) =>
  ({ status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe('ShopifyClient.query — retries vs. idempotency', () => {
  it('re-sends an idempotent query after a 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(502, {}))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(realClient().query('query { ok }')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A gateway can time out on a request the shop went on to process. Re-sending
  // bulkOperationRunMutation then starts a SECOND op importing every row again.
  it('does NOT re-send a non-idempotent mutation after a 5xx — outcome unknown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(502, {}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      realClient().query('mutation { x }', {}, { idempotent: false }),
    ).rejects.toBeInstanceOf(ShopifyOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-send a non-idempotent mutation after a dropped connection', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', fetchMock);

    const err = await realClient()
      .query('mutation { x }', {}, { idempotent: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyOutcomeUnknownError);
    // Still an API error to every existing `instanceof ShopifyApiError` check.
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect((err as Error).message).toMatch(/may or may not/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 429 is Shopify refusing BEFORE running anything — always safe to re-send.
  it('still retries a non-idempotent mutation on 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      realClient().query('mutation { x }', {}, { idempotent: false }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('runBulkMutation submits as non-idempotent', async () => {
    const query = vi.fn(async () => ({
      bulkOperationRunMutation: { bulkOperation: { id: 'gid://op/1', status: 'CREATED' }, userErrors: [] },
    }));
    await runBulkMutation({ query } as unknown as ShopifyClient, 'mutation {}', 'key');
    expect(query.mock.calls[0]).toContainEqual({ idempotent: false });
  });
});

// ── reconcile error classification ───────────────────────────────────────────

describe('classifyReconcileError', () => {
  const submitted = new Date('2026-10-05T00:00:00Z');
  const soon = submitted.getTime() + 60_000;
  const late = submitted.getTime() + MAX_IMPORT_RUNTIME_MS + 1;

  it.each([
    ['a rejected token', new ShopifyAuthError('HTTP 401')],
    ['a wrong shop domain', new ShopifyConfigError('Not Found')],
    ['a vanished operation', new BulkOperationNotFoundError('gid://op/9')],
    ['an unreadable result file', new BulkResultParseError('line 3 is not valid JSON.')],
  ])('fails at once on %s — polling again gives the same answer forever', (_, err) => {
    expect(classifyReconcileError(err, submitted, soon)).toMatchObject({ fail: true });
  });

  it('retries a transient error inside the bound', () => {
    expect(classifyReconcileError(new ShopifyApiError('HTTP 503'), submitted, soon)).toEqual({ fail: false });
  });

  it('gives up on a transient error only once the op is older than the bound', () => {
    const verdict = classifyReconcileError(new ShopifyApiError('HTTP 503'), submitted, late);
    expect(verdict).toMatchObject({ fail: true });
    expect((verdict as { error: string }).error).toMatch(/may still have run/i);
  });

  it('bounds by elapsed time, generously — not by a poll count', () => {
    // The old bound was 300 polls ≈ 15 minutes at a 3s cadence, which failed real
    // imports that were still running. Hours, not minutes.
    expect(MAX_IMPORT_RUNTIME_MS).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
  });

  it('fetchBulkOperationState throws the typed not-found error', async () => {
    const client = { query: async () => ({ node: null }) } as unknown as ShopifyClient;
    await expect(fetchBulkOperationState(client, 'gid://op/1')).rejects.toBeInstanceOf(
      BulkOperationNotFoundError,
    );
  });
});

// ── __lineNumber base, from the submitted count ──────────────────────────────

describe('resolveLineNumberBase', () => {
  const complete = { kind: 'complete' } as const;
  const partial = { kind: 'partial' } as const;

  it('0 when line 0 is present, 1 when line n is present', () => {
    expect(resolveLineNumberBase([0, 1, 2], 3, complete)).toBe(0);
    expect(resolveLineNumberBase([1, 2, 3], 3, complete)).toBe(1);
  });

  // THE BUG. A 0-based completed file missing line 0 starts at 1; inferring the
  // base from the minimum read it as 1-based and shifted every row onto the one
  // above it, with nothing thrown.
  it('refuses a completed 0-based file whose first line is missing, instead of shifting', () => {
    expect(() => resolveLineNumberBase([1, 2], 3, complete)).toThrow(BulkResultParseError);
  });

  it('end to end: no silent shift when line 0 is missing', async () => {
    const body = [{ __lineNumber: 1, data: {} }, { __lineNumber: 2, data: {} }]
      .map((l) => JSON.stringify(l))
      .join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => body }) as unknown as Response));
    await expect(
      fetchAndParseBulkResults('http://x', ['r1', 'r2', 'r3'], complete, (l) => l.ref),
    ).rejects.toThrow(/may be partial data/i);
  });

  it('derives a partial file\'s base when the file itself settles it', () => {
    expect(resolveLineNumberBase([0, 1], 5, partial)).toBe(0);
    expect(resolveLineNumberBase([4, 5], 5, partial)).toBe(1);
  });

  it('refuses to guess a partial file\'s base when it cannot be settled', () => {
    expect(() => resolveLineNumberBase([1, 2], 5, partial)).toThrow(/cannot tell/i);
  });

  it('an explicit partial base always wins', () => {
    expect(resolveLineNumberBase([1, 2], 5, { kind: 'partial', lineNumberBase: 1 })).toBe(1);
  });
});

// ── error lines: `message` or `errors: [{ message }]` ────────────────────────

describe('bulk error lines', () => {
  const errorsLine = {
    __lineNumber: 0,
    errors: [{ message: 'Variable $input of type ProductSetInput! was provided invalid value' }],
  };

  it('reads either shape', () => {
    expect(bulkLineErrorMessage({ message: 'Top level' }, 'fallback')).toBe('Top level');
    expect(bulkLineErrorMessage(errorsLine, 'fallback')).toMatch(/invalid value/);
    expect(bulkLineErrorMessage({}, 'fallback')).toBe('fallback');
  });

  it('products: an errors[] line reports Shopify\'s reason, not "Unknown bulk error."', () => {
    const out = parseProductSetLine({ ref: 'alpha', data: errorsLine, raw: errorsLine });
    expect(out).toMatchObject({ handle: 'alpha', accepted: false });
    expect(out.message).toMatch(/invalid value/);
  });

  it('customers: same, the flows are twins', () => {
    const out = parseCustomerCreateLine({ ref: 7, data: errorsLine, raw: errorsLine });
    expect(out).toMatchObject({ rowNumber: 7, accepted: false });
    expect(out.message).toMatch(/invalid value/);
  });
});

// ── store labels ─────────────────────────────────────────────────────────────

describe('storeLabeller', () => {
  it('labels a single-store run with its own shop domain, not the raw store id', () => {
    const label = storeLabeller({ storeId: 'store3', shopDomain: 'qa3.example.com', batchJobs: [] });
    expect(label('store3')).toBe('qa3.example.com');
  });

  it('labels each batch store from its job', () => {
    const label = storeLabeller({
      storeId: null,
      shopDomain: 'qa1.example.com, qa2.example.com',
      batchJobs: [
        { storeId: 'store1', shopDomain: 'qa1.example.com' },
        { storeId: 'store2', shopDomain: 'qa2.example.com' },
      ],
    });
    expect(label('store2')).toBe('qa2.example.com');
    expect(label(null)).toBe('qa1.example.com, qa2.example.com');
  });
});

// ── product finalize reads Handles only, and must agree with the grouping ────

describe('handlesInOrder', () => {
  it('matches groupByHandle exactly — the lineRefs the import was built from', () => {
    const data: Record<string, string>[] = [
      { Handle: 'alpha', Title: 'A' },
      { Handle: '', 'Image Src': 'https://example.com/a2.png' }, // continues alpha
      { Handle: ' beta ', Title: 'B' },
      { Handle: 'alpha' }, // a repeat does not open a second group
      { Handle: 'gamma' },
    ];
    const groups = groupByHandle(
      data.map((d, i) => ({ rowNumber: i + 1, original: d, normalized: normalizeRecord(d) })),
    );
    expect(handlesInOrder(data.map((d) => d.Handle ?? null))).toEqual(groups.map((g) => g.handle));
    expect(handlesInOrder(['alpha', null, 'beta'])).toEqual(['alpha', 'beta']);
  });
});
