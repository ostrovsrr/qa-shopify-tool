import { useEffect, useMemo, useRef, useState } from 'react';
import { ValidationIssue } from '../types';

interface Props {
  issues: ValidationIssue[];
}

type SortKey = 'rowNumber' | 'column' | 'issueType';
type SortDir = 'asc' | 'desc';
// collapsed → loading (spinner paints) → open (heavy table mounts)
type View = 'collapsed' | 'loading' | 'open';

export function IssuesTable({ issues }: Props) {
  // The Excel validation report is the primary artifact; this table is opt-in.
  // Nothing about it is computed or rendered until the user opens it — important
  // when a run has tens of thousands of issues.
  const [view, setView] = useState<View>('collapsed');
  const [search, setSearch] = useState('');
  const [filterColumn, setFilterColumn] = useState<string>('All');
  const [filterIssueType, setFilterIssueType] = useState<string>('All');
  const [sortKey, setSortKey] = useState<SortKey>('rowNumber');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const rafIds = useRef<number[]>([]);
  const cancelPending = () => {
    rafIds.current.forEach((id) => cancelAnimationFrame(id));
    rafIds.current = [];
  };
  useEffect(() => cancelPending, []);

  const handleToggle = () => {
    if (view !== 'collapsed') {
      // Acts as both "hide" and "cancel a load in progress".
      cancelPending();
      setView('collapsed');
      return;
    }
    setView('loading');
    // Mount the heavy table only after the loading frame has painted, so the
    // spinner is visible before the main thread blocks on rendering the rows.
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => setView('open'));
      rafIds.current.push(id2);
    });
    rafIds.current.push(id1);
  };

  const open = view === 'open';

  const columns = useMemo(
    () => (open ? ['All', ...Array.from(new Set(issues.map((i) => i.column))).sort()] : ['All']),
    [open, issues],
  );
  const issueTypes = useMemo(
    () => (open ? ['All', ...Array.from(new Set(issues.map((i) => i.issueType))).sort()] : ['All']),
    [open, issues],
  );

  const filtered = useMemo(() => {
    if (!open) return [];
    const q = search.toLowerCase();
    return issues
      .filter((i) => {
        if (filterColumn !== 'All' && i.column !== filterColumn) return false;
        if (filterIssueType !== 'All' && i.issueType !== filterIssueType) return false;
        if (
          q &&
          !i.message.toLowerCase().includes(q) &&
          !i.column.toLowerCase().includes(q) &&
          !i.issueType.toLowerCase().includes(q) &&
          !i.currentValue.toLowerCase().includes(q) &&
          !String(i.rowNumber).includes(q)
        )
          return false;
        return true;
      })
      .sort((a, b) => {
        let cmp = 0;
        if (sortKey === 'rowNumber') cmp = a.rowNumber - b.rowNumber;
        else if (sortKey === 'column') cmp = a.column.localeCompare(b.column);
        else if (sortKey === 'issueType') cmp = a.issueType.localeCompare(b.issueType);
        return sortDir === 'asc' ? cmp : -cmp;
      });
  }, [open, issues, search, filterColumn, filterIssueType, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  if (issues.length === 0) return null;

  return (
    <div className="issues-section">
      <button
        type="button"
        className="issues-toggle"
        onClick={handleToggle}
        aria-expanded={open}
      >
        <span className="issues-title">Issues ({issues.length})</span>
        <span className="issues-toggle-hint">
          {view === 'loading' ? (
            <>
              <span className="spinner" /> Loading {issues.length.toLocaleString()} issues…
            </>
          ) : (
            <>
              {open ? 'Hide details' : 'Show details'}
              <span className={`issues-chevron ${open ? 'open' : ''}`}>▾</span>
            </>
          )}
        </span>
      </button>

      {open && (
        <>
      <div className="filters-bar">
        <input
          className="search-input"
          type="text"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="filter-select"
          value={filterColumn}
          onChange={(e) => setFilterColumn(e.target.value)}
        >
          {columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={filterIssueType}
          onChange={(e) => setFilterIssueType(e.target.value)}
        >
          {issueTypes.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>

      <div className="table-wrapper">
        <table className="issues-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('rowNumber')} className="sortable">
                Row{sortIcon('rowNumber')}
              </th>
              <th onClick={() => handleSort('column')} className="sortable">
                Column{sortIcon('column')}
              </th>
              <th onClick={() => handleSort('issueType')} className="sortable">
                Issue Type{sortIcon('issueType')}
              </th>
              <th>Current Value</th>
              <th>Message</th>
              <th>Suggested Fix</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((issue, idx) => (
              <tr key={idx} className="row-error">
                <td className="cell-center">{issue.rowNumber}</td>
                <td>
                  <span className="column-badge">{issue.column}</span>
                </td>
                <td>{issue.issueType}</td>
                <td className="cell-mono">{issue.currentValue || '—'}</td>
                <td>{issue.message}</td>
                <td className="cell-fix">{issue.suggestedFix}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="cell-empty">No issues match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
        </>
      )}
    </div>
  );
}
