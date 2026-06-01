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
  'Total Spent',
  'Total Orders',
] as const;

interface Props {
  preview: CsvPreview;
  onValidate: (mapping: ColumnMapping, heliosMigratedTag: boolean) => void;
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

  const mappedCount = Object.values(mapping).filter(Boolean).length;

  const handleValidate = () => {
    const filtered: ColumnMapping = {};
    for (const [src, tgt] of Object.entries(mapping)) {
      if (tgt) filtered[src] = tgt;
    }
    onValidate(filtered, heliosMigratedTag);
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
                        {SHOPIFY_COLUMNS.map((sc) => (
                          <option key={sc} value={sc}>
                            {sc}
                          </option>
                        ))}
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
