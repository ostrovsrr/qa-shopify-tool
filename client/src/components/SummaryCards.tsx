import { ValidationResult } from '../types';

interface Props {
  result: ValidationResult;
  onDownload: () => void;
}

/** "12 email · 3 both", skipping the zeroes. Empty when everything is zero, so
 *  the caller can fall back to a plain-English line instead of "0 · 0". */
function parts(pairs: [count: number, label: string][]): string {
  return pairs
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ');
}

/** A count of 0 carries no signal, so it stays muted grey however severe the
 *  bucket is — only non-zero buckets take their colour. Same convention as the
 *  existing .card-zero rule. */
function Card({
  tone,
  label,
  value,
  note,
}: {
  tone: 'success' | 'info' | 'error' | 'warning' | 'neutral';
  label: string;
  value: number;
  note: string;
}) {
  return (
    <div className={`card ${value === 0 ? 'card-zero' : `card-${tone}`}`}>
      <span className="card-label">{label}</span>
      <span className="card-value">{value}</span>
      <span className="card-note">{note}</span>
    </div>
  );
}

export function SummaryCards({ result, onDownload }: Props) {
  const s = result.summary;
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
          {/* "No issues found" would be a lie when the tool had to change rows to
              get there. Say what actually happened. */}
          {s && s.fixed > 0
            ? `✓ Nothing blocking import — ${s.fixed} record${s.fixed === 1 ? '' : 's'} needed fixing first, and the tool applied them.`
            : '✓ No issues found — this CSV looks clean and ready to import!'}
        </div>
      )}

      <div className="cards-grid">
        <div className="card card-neutral">
          <span className="card-label">Total Rows</span>
          <span className="card-value">{result.totalRows}</span>
        </div>

        {/* Runs validated before the summary existed carry none, so they keep
            the plain Total/Errors pair rather than showing invented zeroes. */}
        {!s && (
          <div className="card card-error">
            <span className="card-label">Errors</span>
            <span className="card-value">{result.errors}</span>
          </div>
        )}

        {s && (
          <>
            <Card tone="success" label="Ready" value={s.ready} note="import as-is" />

            <Card
              tone="info"
              label="Fixed"
              value={s.fixed}
              note={
                parts([
                  [s.fixedInvalidContact, 'invalid contact'],
                  [s.fixedDuplicates, 'duplicate'],
                  [s.fixedNamed, 'named'],
                ]) || 'nothing needed fixing'
              }
            />

            <Card
              tone="error"
              label="Blocked"
              value={s.blocked}
              note={
                s.blocked === 0
                  ? 'nothing blocking import'
                  : `${s.errorCount} error${s.errorCount === 1 ? '' : 's'} to fix by hand`
              }
            />

            <Card
              tone="neutral"
              label="Removed"
              value={s.removed}
              note={
                parts([
                  [s.removedBlank, 'blank'],
                  [s.removedMerged, 'merged'],
                ]) || 'every row kept'
              }
            />

            {/* Not one of the four buckets: a duplicate is "fixed" when it was
                moved to Note and "blocked" when it was not, so it cuts across
                them. Counts the repeats Shopify would reject, never the keeper. */}
            <Card
              tone="warning"
              label="Duplicates"
              value={s.duplicateRecords}
              note={
                parts([
                  [s.duplicateEmail, 'email'],
                  [s.duplicatePhone, 'phone'],
                  // Spelled out, or email + phone != total reads as a bug.
                  [s.duplicateBoth, 'both'],
                ]) || 'no repeated emails or phones'
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
