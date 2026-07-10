import { ProductImportFeedback, ShopifyStore } from '../types';

interface Props {
  feedback: ProductImportFeedback;
  stores: ShopifyStore[];
  cleaningRun: boolean;
  onDownloadReport: () => void;
  onCleanupRun: () => void;
}

// Presentational results: total / accepted / rejected, rejections grouped by
// (field, code), and the per-store breakdown for parallel runs. No four buckets,
// rule gaps, or Copy-for-Claude — the import is the truth.
export function ProductResultsView({
  feedback,
  stores,
  cleaningRun,
  onDownloadReport,
  onCleanupRun,
}: Props) {
  const storeLabel = (shopDomain: string): string =>
    stores.find((st) => st.shop === shopDomain)?.label ?? shopDomain;

  return (
    <div className="import-results">
      <div className="import-toolbar">
        <span className="muted">
          Import {feedback.importRunId.slice(0, 8)} · {feedback.status} ·{' '}
          {feedback.accepted} accepted / {feedback.rejected} rejected of {feedback.totalProducts}
        </span>
        <div className="toolbar-actions">
          <button className="btn btn-outline" onClick={onDownloadReport}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download report
          </button>
          <button
            className="btn btn-outline btn-sm"
            onClick={onCleanupRun}
            disabled={cleaningRun}
          >
            {cleaningRun ? 'Cleaning…' : 'Clean this import'}
          </button>
          {/* Refresh removed here: the run is already terminal in this view, so
              re-fetching can't change the result. */}
        </div>
      </div>

      {/* Prominent outcome headline — the number that matters most. */}
      <div
        className={`import-headline ${
          feedback.rejected > 0 ? 'import-headline-rejects' : 'import-headline-clean'
        }`}
      >
        <span className="import-headline-icon" aria-hidden="true">
          {feedback.rejected > 0 ? '⚠' : '✓'}
        </span>
        <div className="import-headline-counts">
          <span className="import-headline-numbers">
            <strong className="import-num-accepted">{feedback.accepted}</strong> accepted
            {' · '}
            <strong className="import-num-rejected">{feedback.rejected}</strong> rejected
          </span>
          <span className="import-headline-sub">
            of {feedback.totalProducts} product(s) imported to {feedback.shopDomain}
          </span>
        </div>
      </div>

      {/* Rejected card is gray at 0 (color only when > 0) so a clean run doesn't
          read as alarming. */}
      <div className="cards-grid">
        <div className="card card-neutral">
          <span className="card-label">Total products</span>
          <span className="card-value">{feedback.totalProducts}</span>
        </div>
        <div className="card card-info">
          <span className="card-label">Accepted</span>
          <span className="card-value">{feedback.accepted}</span>
        </div>
        <div className={`card ${feedback.rejected > 0 ? 'card-error' : 'card-zero'}`}>
          <span className="card-label">Rejected</span>
          <span className="card-value">{feedback.rejected}</span>
        </div>
      </div>

      {feedback.perStore.length > 1 && (
        <>
          <h3 className="subsection-title">Per-store results</h3>
          <table className="issues-table">
            <thead>
              <tr>
                <th>Store</th>
                <th>Products</th>
                <th>Accepted</th>
                <th>Rejected</th>
              </tr>
            </thead>
            <tbody>
              {feedback.perStore.map((ps) => (
                <tr key={ps.storeId ?? ps.shopDomain}>
                  <td>{storeLabel(ps.shopDomain)}</td>
                  <td>{ps.total}</td>
                  <td>{ps.accepted}</td>
                  <td>{ps.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 className="subsection-title">Rejections by (field, code)</h3>
      {feedback.rejectionGroups.length === 0 ? (
        <p className="muted">No rejections — every product was accepted.</p>
      ) : (
        <table className="issues-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Code</th>
              <th>Count</th>
              <th>Sample handles</th>
              <th>Sample message</th>
            </tr>
          </thead>
          <tbody>
            {feedback.rejectionGroups.map((g) => (
              <tr key={`${g.shopifyField}|${g.shopifyCode}`}>
                <td>{g.shopifyField ?? '—'}</td>
                <td>{g.shopifyCode ?? '—'}</td>
                <td>{g.count}</td>
                <td className="cell-message">{g.sampleHandles.join(', ') || '—'}</td>
                <td className="cell-message">{g.sampleMessages[0] ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
