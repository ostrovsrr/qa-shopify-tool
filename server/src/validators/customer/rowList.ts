// How many row numbers a duplicate message spells out before summarising the rest.
export const MAX_LISTED_ROWS = 10;

/**
 * "2, 5, 9" — or, for a big group, "2, 5, 9, … and 4,990 more".
 *
 * Every repeat in a duplicate group gets its own issue, so listing the WHOLE group
 * in each message is quadratic: 20,000 rows sharing one placeholder email would be
 * 20,000 messages of 20,000 row numbers each (gigabytes of text, and an OOM). The
 * first few rows are enough to find the group; the count says how big it is.
 */
export function formatRowList(rowNumbers: number[], max = MAX_LISTED_ROWS): string {
  if (rowNumbers.length <= max) return rowNumbers.join(', ');
  const rest = rowNumbers.length - max;
  return `${rowNumbers.slice(0, max).join(', ')} and ${rest.toLocaleString('en-US')} more`;
}
