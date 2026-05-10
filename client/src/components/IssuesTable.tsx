import { useMemo, useState } from 'react';
import { Severity, ValidationIssue } from '../types';

interface Props {
  issues: ValidationIssue[];
}

type SortKey = 'rowNumber' | 'severity' | 'column' | 'issueType';
type SortDir = 'asc' | 'desc';

const SEVERITY_ORDER: Record<Severity, number> = { Error: 0, Warning: 1, Info: 2 };

export function IssuesTable({ issues }: Props) {
  const [search, setSearch] = useState('');
  const [filterSeverity, setFilterSeverity] = useState<string>('All');
  const [filterColumn, setFilterColumn] = useState<string>('All');
  const [filterIssueType, setFilterIssueType] = useState<string>('All');
  const [sortKey, setSortKey] = useState<SortKey>('rowNumber');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const columns = useMemo(
    () => ['All', ...Array.from(new Set(issues.map((i) => i.column))).sort()],
    [issues],
  );
  const issueTypes = useMemo(
    () => ['All', ...Array.from(new Set(issues.map((i) => i.issueType))).sort()],
    [issues],
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return issues
      .filter((i) => {
        if (filterSeverity !== 'All' && i.severity !== filterSeverity) return false;
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
        else if (sortKey === 'severity')
          cmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        else if (sortKey === 'column') cmp = a.column.localeCompare(b.column);
        else if (sortKey === 'issueType') cmp = a.issueType.localeCompare(b.issueType);
        return sortDir === 'asc' ? cmp : -cmp;
      });
  }, [issues, search, filterSeverity, filterColumn, filterIssueType, sortKey, sortDir]);

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
      <h3 className="issues-title">Issues ({filtered.length} of {issues.length})</h3>

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
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value)}
        >
          {['All', 'Error', 'Warning', 'Info'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
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
              <th onClick={() => handleSort('severity')} className="sortable">
                Severity{sortIcon('severity')}
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
              <tr key={idx} className={`row-${issue.severity.toLowerCase()}`}>
                <td className="cell-center">{issue.rowNumber}</td>
                <td>
                  <span className="column-badge">{issue.column}</span>
                </td>
                <td>
                  <span className={`severity-badge severity-${issue.severity.toLowerCase()}`}>
                    {issue.severity}
                  </span>
                </td>
                <td>{issue.issueType}</td>
                <td className="cell-mono">{issue.currentValue || '—'}</td>
                <td>{issue.message}</td>
                <td className="cell-fix">{issue.suggestedFix}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="cell-empty">No issues match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
