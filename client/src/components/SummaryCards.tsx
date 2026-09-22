import { ValidationResult } from '../types';

interface Props {
  result: ValidationResult;
  onDownload: () => void;
}

export function SummaryCards({ result, onDownload }: Props) {
  const allClear = result.errors === 0;

  return (
    <div className="summary-section">
      <div className="summary-header">
        <div>
          <h2 className="summary-title">
            Validation Results
            <span className="summary-filename"> — {result.fileName}</span>
          </h2>
          <p className="summary-id">ID: {result.validationId}</p>
        </div>
        <button className="btn btn-outline" onClick={onDownload}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download Excel Report
        </button>
      </div>

      {allClear && (
        <div className="success-banner">
          ✓ No issues found — this CSV looks clean and ready to import!
        </div>
      )}

      {/* Not errors, but not imported either: without this the row count here
          and the import's row count disagree with no explanation. */}
      {result.droppedBlankRows && result.droppedBlankRows.length > 0 && (
        <p className="muted">
          {result.droppedBlankRows.length === 1 ? 'Row' : 'Rows'}{' '}
          {result.droppedBlankRows.slice(0, 10).join(', ')}
          {result.droppedBlankRows.length > 10 ? '…' : ''} {result.droppedBlankRows.length === 1 ? 'is a' : 'are'}{' '}
          blank line{result.droppedBlankRows.length === 1 ? '' : 's'}, not {result.droppedBlankRows.length === 1 ? 'a customer' : 'customers'}, so{' '}
          {result.droppedBlankRows.length === 1 ? 'it is' : 'they are'} left out of the Shopify Template and the import (
          {result.totalRows - result.droppedBlankRows.length} of {result.totalRows} rows are sent).
        </p>
      )}

      <div className="cards-grid">
        <div className="card card-neutral">
          <span className="card-label">Total Rows</span>
          <span className="card-value">{result.totalRows}</span>
        </div>
        {/* Red only when there is something to fix — same as the product review card. */}
        <div className={`card ${result.errors > 0 ? 'card-error' : 'card-neutral'}`}>
          <span className="card-label">Errors</span>
          <span className="card-value">{result.errors}</span>
        </div>
      </div>
    </div>
  );
}
