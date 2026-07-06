import { useState } from 'react';
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
  onValidate: (
    mapping: ColumnMapping,
    heliosMigratedTag: boolean,
    moveDuplicatesToNotes: boolean,
  ) => void;
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

  const mappedCount = Object.values(mapping).filter(Boolean).length;

  const handleValidate = () => {
    const filtered: ColumnMapping = {};
    for (const [src, tgt] of Object.entries(mapping)) {
      if (tgt) filtered[src] = tgt;
    }
    onValidate(filtered, heliosMigratedTag, moveDuplicatesToNotes);
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
          <label className="helios-tag-label">
            <input
              type="checkbox"
              checked={heliosMigratedTag}
              onChange={(e) => setHeliosMigratedTag(e.target.checked)}
              disabled={loading}
            />
            Add HeliosMigrated Tag
          </label>
          <label
            className="helios-tag-label"
            title="In the Shopify Template sheet, 2nd+ rows of a duplicate group get the duplicated email/phone cleared and appended to Note instead, so Shopify still accepts the customer. Only the duplicated field is moved."
          >
            <input
              type="checkbox"
              checked={moveDuplicatesToNotes}
              onChange={(e) => setMoveDuplicatesToNotes(e.target.checked)}
              disabled={loading}
            />
            Move duplicate emails/phones to Note
          </label>
          <button
            className="btn btn-primary"
            onClick={handleValidate}
            disabled={loading}
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

      <div className="mapping-body">
        {/* Column mapping table */}
        <div className="mapping-table-section">
          <h3 className="mapping-section-title">Column Mapping</h3>
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
