// Excel stores at most 32,767 UTF-16 code units in a cell. ExcelJS will write
// a longer string to the worksheet XML, but desktop Excel then repairs the
// workbook when it opens it. Keep every report value within the file-format
// limit and leave a visible marker when content had to be shortened.
export const EXCEL_CELL_TEXT_LIMIT = 32_767;

export const EXCEL_TRUNCATION_SUFFIX = ' … [truncated for Excel]';

type ExcelCellScalar = string | number | boolean | null | undefined;

export function excelSafeText(value: string): string {
  if (value.length <= EXCEL_CELL_TEXT_LIMIT) return value;

  const prefixLength = EXCEL_CELL_TEXT_LIMIT - EXCEL_TRUNCATION_SUFFIX.length;
  let prefix = value.slice(0, prefixLength);

  // Do not leave an unmatched UTF-16 high surrogate at the cut boundary.
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }

  return `${prefix}${EXCEL_TRUNCATION_SUFFIX}`;
}

export function excelSafeValues(values: readonly ExcelCellScalar[]): (string | number | boolean)[] {
  return values.map((value) => {
    if (typeof value === 'string') return excelSafeText(value);
    return value ?? '';
  });
}

export function excelSafeRecord(
  values: Record<string, ExcelCellScalar>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' ? excelSafeText(value) : (value ?? ''),
    ]),
  );
}
