import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// advanceImportOp — the ONE per-op poll step behind all four reconcile paths
// (customer run, customer batch job, product run, product batch job).
//
// What it must never do:
//   • fail a colleague's import because THIS instance has no token for its store
//     (shared database; History reopens anyone's run);
//   • fail an import, or free its store, while Shopify still reports it RUNNING —
//     however long it has been running;
//   • let a throw (a vanished op, an unreadable result file) escape and leave the
//     run RUNNING with its store held forever.
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL = { ...process.env };
const getShopifyClient = vi.fn();
const fetchBulkOperationState = vi.fn();

vi.mock('../src/services/shopifyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/shopifyClient')>();
  return { ...actual, getShopifyClient: (id?: string) => getShopifyClient(id) };
});
vi.mock('../src/services/shopifyBulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/shopifyBulk')>();
  return {
    ...actual,
    fetchBulkOperationState: (c: unknown, id: string) => fetchBulkOperationState(c, id),
  };
});

const { advanceImportOp } = await import('../src/services/importReconcile');
const { BulkOperationNotFoundError, BulkResultParseError, MAX_IMPORT_RUNTIME_MS } = await import(
  '../src/services/shopifyBulk'
);
const { ShopifyApiError, ShopifyConfigError } = await import('../src/services/shopifyClient');
const { resetShopifyConfigCache } = await import('../src/config/shopify');

const SUBMITTED = new Date('2026-10-05T00:00:00Z');
const LONG_AFTER = SUBMITTED.getTime() + MAX_IMPORT_RUNTIME_MS * 2;

function op(overrides: Partial<Parameters<typeof advanceImportOp>[0]> = {}) {
  return {
    label: 'test op',
    storeId: 'mine',
    bulkOperationId: 'gid://shopify/BulkOperation/1',
    startedAt: SUBMITTED,
    onCompleted: vi.fn(async () => undefined),
    onEnded: vi.fn(async () => undefined),
    onFailed: vi.fn(async () => undefined),
    renewLock: vi.fn(async () => undefined),
    releaseLock: vi.fn(async () => undefined),
    ...overrides,
  };
}

const state = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'gid://shopify/BulkOperation/1',
  status,
  errorCode: null,
  objectCount: '0',
  url: null,
  partialDataUrl: null,
  ...extra,
});

beforeEach(() => {
  // One instance configured for a single store, exactly like a deployed SE.
  process.env.SHOPIFY_TEST_STORES = '[{"shop":"mine.myshopify.com","adminToken":"shpat_x"}]';
  resetShopifyConfigCache();
  getShopifyClient.mockResolvedValue({});
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetShopifyConfigCache();
  getShopifyClient.mockReset();
  fetchBulkOperationState.mockReset();
  vi.restoreAllMocks();
});

describe('advanceImportOp', () => {
  it("leaves a colleague's op alone — never fails it for want of a token", async () => {
    const o = op({ storeId: 'someone-elses-store' });
    expect(await advanceImportOp(o)).toBe('not-owned');
    expect(getShopifyClient).not.toHaveBeenCalled();
    expect(o.onFailed).not.toHaveBeenCalled();
    expect(o.releaseLock).not.toHaveBeenCalled();
  });

  it('with no usable store config, a client that cannot be built is skipped, not failed', async () => {
    process.env.SHOPIFY_TEST_STORES = '[]';
    resetShopifyConfigCache();
    getShopifyClient.mockRejectedValue(new ShopifyConfigError('Store "x" is not configured.'));

    const o = op({ storeId: 'x' });
    expect(await advanceImportOp(o)).toBe('not-owned');
    expect(o.onFailed).not.toHaveBeenCalled();
  });

  // THE POLL-COUNT BUG. A count of 300 polls tripped after ~15 minutes and failed
  // an import Shopify was still running, released its store, and never ingested
  // its results. Elapsed time alone must never fail a RUNNING op.
  it('never fails or releases an op Shopify still reports RUNNING, however old', async () => {
    fetchBulkOperationState.mockResolvedValue(state('RUNNING'));
    const o = op();

    expect(await advanceImportOp(o, LONG_AFTER)).toBe('running');
    expect(o.renewLock).toHaveBeenCalled();
    expect(o.onFailed).not.toHaveBeenCalled();
    expect(o.releaseLock).not.toHaveBeenCalled();
  });

  it('finalizes a COMPLETED op normally, even past the bound', async () => {
    fetchBulkOperationState.mockResolvedValue(state('COMPLETED', { url: 'https://example.com/r' }));
    const o = op();

    expect(await advanceImportOp(o, LONG_AFTER)).toBe('terminal');
    expect(o.onCompleted).toHaveBeenCalled();
    expect(o.releaseLock).toHaveBeenCalled();
  });

  it('hands an op that ended FAILED to onEnded, partialDataUrl included', async () => {
    const ended = state('FAILED', { errorCode: 'INTERNAL_SERVER_ERROR', partialDataUrl: 'https://example.com/p' });
    fetchBulkOperationState.mockResolvedValue(ended);
    const o = op();

    expect(await advanceImportOp(o)).toBe('terminal');
    expect(o.onEnded).toHaveBeenCalledWith(ended, 'Bulk operation FAILED (INTERNAL_SERVER_ERROR).');
    expect(o.releaseLock).toHaveBeenCalled();
  });

  it('fails (and frees the store) when the op no longer exists', async () => {
    fetchBulkOperationState.mockRejectedValue(new BulkOperationNotFoundError('gid://shopify/BulkOperation/1'));
    const o = op();

    expect(await advanceImportOp(o)).toBe('terminal');
    expect(o.onFailed).toHaveBeenCalledWith(expect.stringMatching(/not found/i));
    expect(o.releaseLock).toHaveBeenCalled();
  });

  // A throw inside finalize used to escape the GET poll and leave the run RUNNING,
  // store held, retried forever on a file that will never parse.
  it('fails (and frees the store) when finalize hits an unreadable result file', async () => {
    fetchBulkOperationState.mockResolvedValue(state('COMPLETED', { url: 'https://example.com/r' }));
    const o = op({ onCompleted: vi.fn(async () => Promise.reject(new BulkResultParseError('bad line'))) });

    expect(await advanceImportOp(o)).toBe('terminal');
    expect(o.onFailed).toHaveBeenCalledWith(expect.stringMatching(/could not be read/i));
    expect(o.releaseLock).toHaveBeenCalled();
  });

  it('leaves a transient error for the next poll inside the bound, and does not throw', async () => {
    fetchBulkOperationState.mockRejectedValue(new ShopifyApiError('HTTP 503'));
    const o = op();

    expect(await advanceImportOp(o, SUBMITTED.getTime() + 60_000)).toBe('retry');
    expect(o.onFailed).not.toHaveBeenCalled();
    expect(o.releaseLock).not.toHaveBeenCalled();
  });

  it('gives up on a transient error past the bound — the state is unknowable by then', async () => {
    fetchBulkOperationState.mockRejectedValue(new ShopifyApiError('HTTP 503'));
    const o = op();

    expect(await advanceImportOp(o, LONG_AFTER)).toBe('terminal');
    expect(o.onFailed).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
    expect(o.releaseLock).toHaveBeenCalled();
  });

  it('fails a row with no store recorded — nobody can ever poll it', async () => {
    const o = op({ storeId: null });
    expect(await advanceImportOp(o)).toBe('terminal');
    expect(o.onFailed).toHaveBeenCalledWith(expect.stringMatching(/no store/i));
  });
});
