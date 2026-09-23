import { useEffect, useState } from 'react';
import { previewFlagEffects } from '../api/validationApi';
import type { EffectsPreview, TemplateFlags } from '../api/validationApi';
import { OptionsPanel } from './OptionsPanel';
import { ColumnMapping, CsvPreview } from '../types';

const SHOPIFY_COLUMNS = [
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Accepts Email Marketing',
  'Accepts SMS Marketing',
  'Tags',
  'Note',
  'Tax Exempt',
  'Default Address Company',
  'Default Address Address1',
  'Default Address Address2',
  'Default Address City',
  'Default Address Province Code',
  'Default Address Country Code',
  'Default Address Zip',
  'Default Address Phone',
] as const;

// Append directives: the column's value is appended to Tags (comma-separated)
// or Note (" | "-separated) instead of replacing a field. Multiple source
// columns can use the same append target.
const APPEND_TARGETS = ['Add to Tags', 'Add to Note'] as const;

// Pass-through directive: the column is carried into the Shopify Template
// as-is, under its original name. Multiple columns can be kept.
const KEEP_TARGET = 'Keep';

interface Props {
  preview: CsvPreview;
  onValidate: (mapping: ColumnMapping, flags: TemplateFlags) => void;
  onBack: () => void;
  loading: boolean;
}

export function ColumnMappingScreen({ preview, onValidate, onBack, loading }: Props) {
  const [mapping, setMapping] = useState<ColumnMapping>(() => {
    const initial: ColumnMapping = {};
    for (const col of preview.headers) {
      initial[col] = preview.suggestedMapping[col] ?? '';
    }
    return initial;
  });
  const [heliosMigratedTag, setHeliosMigratedTag] = useState(true);
  const [moveDuplicatesToNotes, setMoveDuplicatesToNotes] = useState(false);
  const [mergeMatchingDuplicates, setMergeMatchingDuplicates] = useState(false);
  // Both off by default: each one edits the data the operator is about to hand
  // to Shopify, so it happens only when they ask for it.
  const [moveInvalidContactToNotes, setMoveInvalidContactToNotes] = useState(false);
  const [fillMissingContactName, setFillMissingContactName] = useState(false);

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const targetCounts = new Map<string, number>();
  for (const target of Object.values(mapping)) {
    if (
      !target ||
      target === KEEP_TARGET ||
      (APPEND_TARGETS as readonly string[]).includes(target)
    ) {
      continue;
    }
    targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
  }
  const duplicateTargets = [...targetCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([target]) => target);

  const flags: TemplateFlags = {
    heliosMigratedTag,
    moveDuplicatesToNotes,
    mergeMatchingDuplicates,
    moveInvalidContactToNotes,
    fillMissingContactName,
  };

  const filteredMapping = () => {
    const filtered: ColumnMapping = {};
    for (const [src, tgt] of Object.entries(mapping)) {
      if (tgt) filtered[src] = tgt;
    }
    return filtered;
  };

  // What each option would do to THIS file. Debounced because it re-reads and
  // re-parses the CSV server-side, and an operator flicking three switches
  // should cost one request, not three. A mapping collision is skipped outright:
  // the server would 400 on it, and the screen already says so.
  const [effects, setEffects] = useState<EffectsPreview | null>(null);
  const [effectsLoading, setEffectsLoading] = useState(false);
  const mappingKey = JSON.stringify(filteredMapping());
  const flagsKey = JSON.stringify(flags);

  useEffect(() => {
    if (duplicateTargets.length > 0) {
      setEffects(null);
      return;
    }
    let cancelled = false;
    setEffectsLoading(true);
    const timer = setTimeout(() => {
      previewFlagEffects(preview.uploadId, JSON.parse(mappingKey), JSON.parse(flagsKey))
        .then((data) => {
          if (!cancelled) setEffects(data);
        })
        // A failed preview is not worth an error banner — the numbers simply do
        // not appear, and Validate still works.
        .catch(() => {
          if (!cancelled) setEffects(null);
        })
        .finally(() => {
          if (!cancelled) setEffectsLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [preview.uploadId, mappingKey, flagsKey, duplicateTargets.length]);

  const handleValidate = () => {
    onValidate(filteredMapping(), flags);
  };

  return (
    <div className="mapping-card">
      <div className="mapping-header">
        <div className="mapping-header-left">
          <button className="btn btn-outline btn-sm" onClick={onBack} disabled={loading}>
            ← Back
          </button>
          <div>
            <h2 className="mapping-title">Map Columns</h2>
            <p className="mapping-subtitle">
              {preview.fileName} &middot; {preview.headers.length} columns &middot;{' '}
              <span className={mappedCount === 0 ? 'mapping-count-zero' : 'mapping-count'}>
                {mappedCount} mapped
              </span>
            </p>
          </div>
        </div>
        <div className="mapping-header-right">
          <button
            className="btn btn-primary"
            onClick={handleValidate}
            disabled={loading || duplicateTargets.length > 0}
          >
            {loading ? (
              <>
                <span className="spinner" /> Validating&hellip;
              </>
            ) : (
              'Validate CSV'
            )}
          </button>
        </div>
      </div>

      <OptionsPanel
        flags={flags}
        set={{
          heliosMigratedTag: setHeliosMigratedTag,
          moveDuplicatesToNotes: setMoveDuplicatesToNotes,
          mergeMatchingDuplicates: setMergeMatchingDuplicates,
          moveInvalidContactToNotes: setMoveInvalidContactToNotes,
          fillMissingContactName: setFillMissingContactName,
        }}
        effects={effects}
        effectsLoading={effectsLoading}
        disabled={loading}
      />


      <div className="mapping-body">
        {/* Column mapping table */}
        <div className="mapping-table-section">
          <h3 className="mapping-section-title">Column Mapping</h3>
          {duplicateTargets.length > 0 && (
            <div className="error-banner">
              Map only one source column to each Shopify field. Choose a single source for:{' '}
              {duplicateTargets.join(', ')}.
            </div>
          )}
          <div className="mapping-table-wrap">
            <table className="mapping-table">
              <thead>
                <tr>
                  <th>Source Column (CSV)</th>
                  <th>Shopify Field</th>
                </tr>
              </thead>
              <tbody>
                {preview.headers.map((col) => (
                  <tr key={col} className={mapping[col] ? 'mapping-row-mapped' : 'mapping-row-unmapped'}>
                    <td className="mapping-source-col">{col}</td>
                    <td>
                      <select
                        className="mapping-select"
                        value={mapping[col] ?? ''}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [col]: e.target.value }))
                        }
                        disabled={loading}
                      >
                        <option value="">— Ignore —</option>
                        <option value={KEEP_TARGET}>Keep (as-is)</option>
                        {SHOPIFY_COLUMNS.map((sc) => (
                          <option key={sc} value={sc}>
                            {sc}
                          </option>
                        ))}
                        <optgroup label="Append">
                          {APPEND_TARGETS.map((at) => (
                            <option key={at} value={at}>
                              {at}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Sample data preview */}
        {preview.sampleRows.length > 0 && (
          <div className="mapping-sample-section">
            <h3 className="mapping-section-title">
              Sample Data
              <span className="mapping-section-subtitle">
                first {preview.sampleRows.length} rows
              </span>
            </h3>
            <div className="mapping-sample-scroll">
              <table className="mapping-sample-table">
                <thead>
                  <tr>
                    {preview.headers.map((col) => (
                      <th key={col} className={mapping[col] ? 'sample-col-mapped' : ''}>
                        {col}
                        {mapping[col] && (
                          <span className="sample-col-target">&rarr; {mapping[col]}</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sampleRows.map((row, i) => (
                    <tr key={i}>
                      {preview.headers.map((col) => (
                        <td key={col} className={mapping[col] ? 'sample-cell-mapped' : ''}>
                          {row[col] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
