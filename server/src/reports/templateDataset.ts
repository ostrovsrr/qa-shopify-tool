import { AutoFixEntry } from './autoFix';
import { mergeMatchingDuplicateRows, TemplateRow } from './mergeDuplicates';
import { applyMappingToRecord } from '../services/columnMapping.service';
import { canonicalPhone } from '../utils/normalize';

export const HELIOS_TAG = 'HeliosMigrated';

export interface DuplicateGroups {
  /** rowNumber → duplicate group # (only rows that are part of a group). */
  groups: Map<number, number>;
  /** Every group row except the keeper (the most-filled record, ties broken by
   *  earliest row) — the rows whose duplicated value is moved to Note when the
   *  move-duplicates option is on. */
  repeats: Set<number>;
}

/** The final customer dataset a validation run produces: column mapping,
 *  auto-fixes, optional same-person merging, optional move-duplicates-to-Notes,
 *  and the HeliosMigrated tag all applied to each surviving row's record.
 *  Both the Excel "Shopify Template" sheet and the test-store import build from
 *  this, so what gets imported is exactly what the template shows. */
export interface TemplateDataset {
  rows: TemplateRow[];
  emailDupes: DuplicateGroups;
  phoneDupes: DuplicateGroups;
  anyMerges: boolean;
  /** rowNumber → shopify column → fixed value (for the report's highlight). */
  fixMap: Map<number, Map<string, string>>;
}

export interface TemplateDatasetOptions {
  originalRows: { rowNumber: number; data: unknown }[];
  columnMapping?: Record<string, string> | null;
  autoFixes?: AutoFixEntry[];
  heliosMigratedTag?: boolean;
  moveDuplicatesToNotes?: boolean;
  mergeMatchingDuplicates?: boolean;
}

/** Assign duplicate-group numbers per surviving row, grouped by a Shopify
 *  field's value. Matches the DuplicateEmail/DuplicatePhone validator
 *  normalization so reports stay consistent. */
function buildDuplicateGroups(
  templateRows: TemplateRow[],
  completeness: Map<number, number>,
  field: string,
  normalize: (value: string) => string,
): DuplicateGroups {
  const groups = new Map<number, number>();
  const repeats = new Set<number>();

  const order: string[] = [];
  const byValue = new Map<string, number[]>();
  for (const row of templateRows) {
    const normalized = normalize(row.record[field] ?? '');
    if (!normalized) continue;
    if (!byValue.has(normalized)) {
      byValue.set(normalized, []);
      order.push(normalized);
    }
    byValue.get(normalized)!.push(row.rowNumber);
  }

  let groupNumber = 0;
  for (const value of order) {
    const rowNumbers = byValue.get(value)!;
    if (rowNumbers.length < 2) continue;
    groupNumber++;
    let keeper = rowNumbers[0];
    for (const rowNumber of rowNumbers) {
      if ((completeness.get(rowNumber) ?? 0) > (completeness.get(keeper) ?? 0)) {
        keeper = rowNumber;
      }
    }
    for (const rowNumber of rowNumbers) {
      groups.set(rowNumber, groupNumber);
      if (rowNumber !== keeper) repeats.add(rowNumber);
    }
  }
  return { groups, repeats };
}

export function buildTemplateDataset(options: TemplateDatasetOptions): TemplateDataset {
  const {
    originalRows,
    autoFixes = [],
    heliosMigratedTag = false,
    moveDuplicatesToNotes = false,
    mergeMatchingDuplicates = false,
  } = options;
  const columnMapping = options.columnMapping ?? {};
  const hasMapping = Object.keys(columnMapping).length > 0;

  // rowNumber → shopify column → fixed value
  const fixMap = new Map<number, Map<string, string>>();
  for (const fix of autoFixes) {
    if (!fixMap.has(fix.rowNumber)) fixMap.set(fix.rowNumber, new Map());
    fixMap.get(fix.rowNumber)!.set(fix.field, fix.fixedValue);
  }

  // Build one Shopify-column-keyed record per row up front (mapped values with
  // auto-fixes applied), so the optional merge pass and duplicate detection
  // both see final values. With a mapping, only mapped source columns
  // contribute; without one the CSV is already Shopify-keyed and passes
  // through as-is.
  let templateRows: TemplateRow[] = originalRows.map((origRow) => {
    const data = (origRow.data ?? {}) as Record<string, string>;
    let record: Record<string, string>;
    if (hasMapping) {
      const mappedSources: Record<string, string> = {};
      for (const src of Object.keys(columnMapping)) mappedSources[src] = data[src] ?? '';
      record = applyMappingToRecord(mappedSources, columnMapping);
    } else {
      record = { ...data };
    }
    const fixes = fixMap.get(origRow.rowNumber);
    if (fixes) for (const [field, value] of fixes) record[field] = value;
    return { rowNumber: origRow.rowNumber, record, mergedFrom: [] };
  });

  // Merge same-person duplicates (same email/phone AND matching non-empty
  // name) before duplicate handling, so fully-merged groups stop being
  // duplicates and move-to-Notes only deals with what remains.
  if (mergeMatchingDuplicates) {
    templateRows = mergeMatchingDuplicateRows(templateRows);
  }
  const anyMerges = templateRows.some((row) => row.mergedFrom.length > 0);

  // Completeness score per surviving row (recomputed after merging, since a
  // merged keeper absorbs fields). Used to pick which row of a duplicate group
  // keeps its email/phone when moving duplicates to Note.
  const completeness = new Map<number, number>();
  for (const row of templateRows) {
    completeness.set(
      row.rowNumber,
      Object.values(row.record).filter((v) => (v ?? '').trim() !== '').length,
    );
  }

  const emailDupes = buildDuplicateGroups(
    templateRows,
    completeness,
    'Email',
    (v) => v.trim().toLowerCase(),
  );
  const phoneDupes = buildDuplicateGroups(templateRows, completeness, 'Phone', canonicalPhone);

  // Apply the row-level transformations directly to the records so every
  // consumer (Excel template sheet, test-store import) sees the same final
  // dataset.
  for (const row of templateRows) {
    const record = row.record;

    // Strip the duplicated identifier from every group row except the keeper
    // (most-filled record) and stash it in Note, so Shopify accepts the
    // customer instead of rejecting it as "taken". Only the duplicated field
    // is stripped — a row that's only an email duplicate keeps its phone, and
    // vice versa.
    if (moveDuplicatesToNotes) {
      const moved: string[] = [];
      const dupTags: string[] = [];
      if (emailDupes.repeats.has(row.rowNumber)) {
        const email = (record['Email'] ?? '').trim();
        if (email) {
          moved.push(`Duplicate email: ${email}`);
          dupTags.push('DuplicateEmailNotes');
          record['Email'] = '';
        }
      }
      if (phoneDupes.repeats.has(row.rowNumber)) {
        const phone = (record['Phone'] ?? '').trim();
        if (phone) {
          moved.push(`Duplicate phone: ${phone}`);
          dupTags.push('DuplicatePhoneNotes');
          record['Phone'] = '';
        }
      }
      if (moved.length > 0) {
        const existingNote = (record['Note'] ?? '').trim();
        record['Note'] = [existingNote, ...moved].filter(Boolean).join(' | ');
        // Tag the stripped rows (never the keeper) so they're filterable in
        // Shopify admin after import
        const existingTags = (record['Tags'] ?? '').trim();
        record['Tags'] = [existingTags, ...dupTags].filter(Boolean).join(',');
      }
    }

    if (heliosMigratedTag) {
      const existing = record['Tags'] ?? '';
      record['Tags'] = existing ? `${existing},${HELIOS_TAG}` : HELIOS_TAG;
    }
  }

  return { rows: templateRows, emailDupes, phoneDupes, anyMerges, fixMap };
}
