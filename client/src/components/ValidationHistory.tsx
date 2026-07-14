import { useEffect, useRef, useState } from 'react';
import { deleteValidation, fetchHistory, updateValidationMetadata } from '../api/validationApi';
import {
  UpdateMetadataPayload,
  ValidationHistoryImport,
  ValidationHistoryItem,
} from '../types';

// Shows whether a run was imported to Shopify and how it landed. Completed runs
// surface the accepted/rejected split so the outcome is obvious at a glance.
function ImportBadge({ lastImport }: { lastImport: ValidationHistoryImport | null }) {
  if (!lastImport) return null;
  const { status, successCount, errorCount } = lastImport;
  if (status === 'COMPLETED') {
    const clean = errorCount === 0;
    return (
      <span
        className={`badge ${clean ? 'badge-imported' : 'badge-imported-rejects'}`}
        title={`Imported to Shopify: ${successCount} accepted, ${errorCount} rejected`}
      >
        ⬆ Imported · {successCount}✓ / {errorCount}✗
      </span>
    );
  }
  if (status === 'RUNNING') {
    return (
      <span className="badge badge-importing" title="Import in progress">
        ⬆ Importing…
      </span>
    );
  }
  return (
    <span className="badge badge-error" title={`Import ${status.toLowerCase()}`}>
      ⬆ Import {status.toLowerCase()}
    </span>
  );
}

interface Props {
  onOpen: (id: string) => void;
  refreshTrigger: number;
}

interface EditState {
  ticketNumber: string;
  ticketName: string;
  comments: string;
}

function MetadataEditor({
  item,
  onSave,
  onCancel,
}: {
  item: ValidationHistoryItem;
  onSave: (id: string, payload: UpdateMetadataPayload) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<EditState>({
    ticketNumber: item.ticketNumber ?? '',
    ticketName: item.ticketName ?? '',
    comments: item.comments ?? '',
  });
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await onSave(item.id, {
      ticketNumber: form.ticketNumber.trim() || null,
      ticketName: form.ticketName.trim() || null,
      comments: form.comments.trim() || null,
    });
    setSaving(false);
  };

  return (
    <div className="metadata-editor" onClick={(e) => e.stopPropagation()}>
      <div className="metadata-field">
        <label className="metadata-label">Ticket #</label>
        <input
          ref={firstRef}
          className="metadata-input"
          type="text"
          placeholder="e.g. JIRA-123"
          maxLength={100}
          value={form.ticketNumber}
          onChange={(e) => setForm((f) => ({ ...f, ticketNumber: e.target.value }))}
        />
      </div>
      <div className="metadata-field">
        <label className="metadata-label">Ticket name</label>
        <input
          className="metadata-input"
          type="text"
          placeholder="Short description"
          maxLength={255}
          value={form.ticketName}
          onChange={(e) => setForm((f) => ({ ...f, ticketName: e.target.value }))}
        />
      </div>
      <div className="metadata-field">
        <label className="metadata-label">Comments</label>
        <textarea
          className="metadata-textarea"
          placeholder="Any notes about this run…"
          maxLength={2000}
          rows={3}
          value={form.comments}
          onChange={(e) => setForm((f) => ({ ...f, comments: e.target.value }))}
        />
      </div>
      <div className="metadata-actions">
        <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ValidationHistory({ onOpen, refreshTrigger }: Props) {
  const [history, setHistory] = useState<ValidationHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetchHistory()
      .then(setHistory)
      .catch(() => setError('Failed to load history.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [refreshTrigger]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this validation run?')) return;
    try {
      await deleteValidation(id);
      setHistory((h) => h.filter((item) => item.id !== id));
    } catch {
      alert('Failed to delete validation run.');
    }
  };

  const handleEditToggle = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId((prev) => (prev === id ? null : id));
  };

  const handleSaveMetadata = async (id: string, payload: UpdateMetadataPayload) => {
    try {
      const updated = await updateValidationMetadata(id, payload);
      setHistory((h) => h.map((item) => (item.id === id ? { ...item, ...updated } : item)));
      setEditingId(null);
    } catch {
      alert('Failed to save metadata.');
    }
  };

  if (loading) return <p className="history-loading">Loading history…</p>;
  if (error) return <p className="history-error">{error}</p>;
  if (history.length === 0)
    return <p className="history-empty">No previous validation runs found.</p>;

  return (
    <div className="history-section">
      <h3 className="history-title">Validation History</h3>
      <div className="history-list">
        {history.map((item) => (
          <div key={item.id} className="history-item-wrapper">
            <div
              className="history-item"
              onClick={() => onOpen(item.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onOpen(item.id)}
            >
              <div className="history-item-info">
                <span className="history-filename">{item.fileName}</span>
                <span className="history-date">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
                {item.createdBy && item.createdBy !== 'unknown' && (
                  <span className="history-actor">by {item.createdBy}</span>
                )}
                {/* The raw rows were purged for retention, so the report can no
                    longer be rebuilt. Say so rather than offering a download that
                    would fail. */}
                {item.piiPurgedAt && (
                  <span
                    className="history-purged"
                    title={`Uploaded rows were deleted on ${new Date(
                      item.piiPurgedAt,
                    ).toLocaleDateString()} under the data-retention policy. Re-upload the CSV to run it again.`}
                  >
                    rows purged
                  </span>
                )}
                {/* Metadata summary row */}
                {(item.ticketNumber || item.ticketName || item.comments) && (
                  <div className="history-metadata-summary">
                    {item.ticketNumber && (
                      <span className="metadata-chip metadata-chip-ticket">
                        #{item.ticketNumber}
                      </span>
                    )}
                    {item.ticketName && (
                      <span className="metadata-chip metadata-chip-name">
                        {item.ticketName}
                      </span>
                    )}
                    {item.comments && (
                      <span
                        className="metadata-chip metadata-chip-comments"
                        title={item.comments}
                      >
                        💬 {item.comments.length > 60
                          ? item.comments.slice(0, 60) + '…'
                          : item.comments}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="history-item-badges">
                <span className="badge badge-neutral">{item.totalRows} rows</span>
                {item.errors > 0 && (
                  <span className="badge badge-error">{item.errors} errors</span>
                )}
                {item.warnings > 0 && (
                  <span className="badge badge-warning">{item.warnings} warnings</span>
                )}
                {item.info > 0 && (
                  <span className="badge badge-info">{item.info} info</span>
                )}
                {item.errors === 0 && item.warnings === 0 && item.info === 0 && (
                  <span className="badge badge-success">Clean</span>
                )}
                <ImportBadge lastImport={item.lastImport} />
              </div>

              <div className="history-item-actions">
                <button
                  className={`btn btn-ghost btn-sm ${editingId === item.id ? 'btn-active' : ''}`}
                  onClick={(e) => handleEditToggle(item.id, e)}
                  title="Edit metadata"
                >
                  ✎
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={(e) => handleDelete(item.id, e)}
                  title="Delete this run"
                >
                  ✕
                </button>
              </div>
            </div>

            {editingId === item.id && (
              <MetadataEditor
                item={item}
                onSave={handleSaveMetadata}
                onCancel={() => setEditingId(null)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
