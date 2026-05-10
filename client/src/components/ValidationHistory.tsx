import { useEffect, useState } from 'react';
import { deleteValidation, fetchHistory } from '../api/validationApi';
import { ValidationHistoryItem } from '../types';

interface Props {
  onOpen: (id: string) => void;
  refreshTrigger: number;
}

export function ValidationHistory({ onOpen, refreshTrigger }: Props) {
  const [history, setHistory] = useState<ValidationHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    fetchHistory()
      .then(setHistory)
      .catch(() => setError('Failed to load history.'))
      .finally(() => setLoading(false));
  };

  // Reload whenever a new validation completes
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

  if (loading) return <p className="history-loading">Loading history…</p>;
  if (error) return <p className="history-error">{error}</p>;
  if (history.length === 0)
    return <p className="history-empty">No previous validation runs found.</p>;

  return (
    <div className="history-section">
      <h3 className="history-title">Validation History</h3>
      <div className="history-list">
        {history.map((item) => (
          <div
            key={item.id}
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
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={(e) => handleDelete(item.id, e)}
              title="Delete this run"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
