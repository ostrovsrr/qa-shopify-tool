import { describe, expect, it } from 'vitest';
import {
  EXCEL_CELL_TEXT_LIMIT,
  EXCEL_TRUNCATION_SUFFIX,
  excelSafeRecord,
  excelSafeText,
} from '../src/reports/excelCell';

describe('Excel cell safety', () => {
  it('keeps strings at or below Excel\'s cell limit unchanged', () => {
    const value = 'x'.repeat(EXCEL_CELL_TEXT_LIMIT);
    expect(excelSafeText(value)).toBe(value);
  });

  it('truncates oversized strings to a valid Excel cell value', () => {
    const value = 'x'.repeat(EXCEL_CELL_TEXT_LIMIT + 10_000);
    const safe = excelSafeText(value);

    expect(safe).toHaveLength(EXCEL_CELL_TEXT_LIMIT);
    expect(safe.endsWith(EXCEL_TRUNCATION_SUFFIX)).toBe(true);
  });

  it('does not split a UTF-16 surrogate pair at the truncation boundary', () => {
    const prefixLength = EXCEL_CELL_TEXT_LIMIT - EXCEL_TRUNCATION_SUFFIX.length;
    const value = `${'x'.repeat(prefixLength - 1)}😀${'z'.repeat(100)}`;
    const safe = excelSafeText(value);
    const codeUnitBeforeSuffix = safe.charCodeAt(safe.length - EXCEL_TRUNCATION_SUFFIX.length - 1);

    expect(codeUnitBeforeSuffix).not.toBeGreaterThanOrEqual(0xd800);
    expect(safe.length).toBeLessThanOrEqual(EXCEL_CELL_TEXT_LIMIT);
  });

  it('sanitizes string fields without changing numbers or booleans', () => {
    const safe = excelSafeRecord({
      rows: '1, '.repeat(20_000),
      count: 20_000,
      accepted: true,
    });

    expect((safe.rows as string).length).toBeLessThanOrEqual(EXCEL_CELL_TEXT_LIMIT);
    expect(safe.count).toBe(20_000);
    expect(safe.accepted).toBe(true);
  });
});
