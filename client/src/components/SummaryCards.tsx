import { ValidationResult, ValidationSummary } from '../types';

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

/**
 * The four buckets are a PARTITION — they sum to the row count — so they are
 * drawn as one divided bar. Six identical tiles said "six equal facts", which
 * was wrong three ways: Total Rows is the denominator rather than a peer,
 * Ready/Fixed/Blocked/Removed add up to it, and Duplicates deliberately cuts
 * across them (a duplicate is Fixed when moved to Note and Blocked when not).
 * The bar makes the partition true on screen instead of only in the code.
 */
function Bar({ s }: { s: ValidationSummary }) {
  const total = s.totalRows || 1;
  const segs = [
    { key: 'ready', n: s.ready, cls: 'seg-ready', label: 'ready' },
    { key: 'fixed', n: s.fixed, cls: 'seg-fixed', label: 'fixed' },
    { key: 'blocked', n: s.blocked, cls: 'seg-blocked', label: '' },
    { key: 'removed', n: s.removed, cls: 'seg-removed', label: '' },
  ].filter((seg) => seg.n > 0);

  return (
    <div className="summary-bar" role="img"
      aria-label={`${s.ready} ready, ${s.fixed} fixed, ${s.blocked} blocked, ${s.removed} removed of ${s.totalRows} rows`}
    >
      {segs.map((seg) => {
        const pct = (seg.n / total) * 100;
        return (
          <div
            key={seg.key}
            className={`summary-seg ${seg.cls}`}
            style={{ width: `${pct}%` }}
            title={`${seg.n.toLocaleString()} ${seg.key}`}
          >
            {/* A sliver cannot hold text; the title attribute carries it. */}
            {pct > 12 ? `${seg.n.toLocaleString()}${seg.label ? ` ${seg.label}` : ''}` : ''}
          </div>
        );
      })}
    </div>
  );
}

function Legend({
  tone,
  label,
  value,
  note,
}: {
  tone: string;
  label: string;
  value: number;
  note: string;
}) {
  // A count of 0 carries no signal, so it stays muted however severe the bucket
  // is — same convention as the .card-zero rule.
  return (
    <div className={`summary-legend ${value === 0 ? 'legend-zero' : `legend-${tone}`}`}>
      <span className="legend-label">{label}</span>
      <span className="legend-value">{value.toLocaleString()}</span>
      <span className="legend-note">{note}</span>
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

      {/* Runs validated before the summary existed carry none, so they keep the
          plain Total/Errors pair rather than showing invented zeroes. */}
      {!s ? (
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
      ) : (
        <div className="summary-outcome">
          <p className="summary-rows">
            <b>{s.totalRows.toLocaleString()} rows</b> in {result.fileName}
          </p>

          <Bar s={s} />

          <div className="summary-legends">
            <Legend tone="ready" label="Ready" value={s.ready} note="import as-is" />
            <Legend
              tone="fixed"
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
            <Legend
              tone="blocked"
              label="Blocked"
              value={s.blocked}
              note={
                s.blocked === 0
                  ? 'nothing blocking import'
                  : `${s.errorCount} error${s.errorCount === 1 ? '' : 's'} to fix by hand`
              }
            />
            <Legend
              tone="removed"
              label="Removed"
              value={s.removed}
              note={
                parts([
                  [s.removedBlank, 'blank'],
                  [s.removedMerged, 'merged'],
                ]) || 'every row kept'
              }
            />
          </div>

          {/* Below the rule on purpose: duplicates are not one of the four
              buckets, they cut across them. Counts the repeats Shopify would
              reject, never the keeper, which imports fine. */}
          <div className="summary-diagnostics">
            <span className="summary-diag-label">Also worth knowing</span>
            {s.duplicateRecords > 0 ? (
              <span className="summary-chip">
                {s.duplicateRecords} duplicate record{s.duplicateRecords === 1 ? '' : 's'} —{' '}
                {parts([
                  [s.duplicateEmail, 'email'],
                  [s.duplicatePhone, 'phone'],
                  // Spelled out, or email + phone != total reads as a bug.
                  [s.duplicateBoth, 'both'],
                ])}
              </span>
            ) : (
              <span className="summary-diag-none">No repeated emails or phones.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
