export interface AutoFixEntry {
  rowNumber: number;
  field: string;
  originalValue: string;
  fixedValue: string;
  fixType: string;
  confidence: 'High' | 'Medium' | 'Low';
  reason: string;
}

export function computeAutoFixes(
  _originalRows: { rowNumber: number; data: unknown }[],
  _columnMapping: Record<string, string>,
): AutoFixEntry[] {
  return [];
}
