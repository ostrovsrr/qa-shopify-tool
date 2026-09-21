import { AutoFixEntry } from './autoFix';
import { mergeMatchingDuplicateRows, TemplateRow } from './mergeDuplicates';
import { applyMappingToRecord } from '../services/columnMapping.service';
import { canonicalPhone, isRowFullyEmpty } from '../utils/normalize';
import { emailProblem, phoneProblem } from '../validators/customer/contactValidity';

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
 *  auto-fixes, optional same-person merging, optional move-invalid-to-Notes,
 *  optional move-duplicates-to-Notes, optional placeholder names, and the
 *  HeliosMigrated tag all applied to each surviving row's record.
 *  Both the Excel "Shopify Template" sheet and the test-store import build from
 *  this, so what gets imported is exactly what the template shows. */
export interface TemplateDataset {
  rows: TemplateRow[];
  emailDupes: DuplicateGroups;
  phoneDupes: DuplicateGroups;
  anyMerges: boolean;
  /** rowNumber → shopify column → fixed value (for the report's highlight). */
  fixMap: Map<number, Map<string, string>>;
  /** Rows whose invalid Email/Phone was stripped into Note. */
  invalidMoved: Set<number>;
  /** Rows given a placeholder First Name so Shopify would accept them. */
  namesFilled: Set<number>;
}

export interface TemplateDatasetOptions {
  originalRows: { rowNumber: number; data: unknown }[];
  columnMapping?: Record<string, string> | null;
  autoFixes?: AutoFixEntry[];
  heliosMigratedTag?: boolean;
  moveDuplicatesToNotes?: boolean;
  mergeMatchingDuplicates?: boolean;
  moveInvalidContactToNotes?: boolean;
  fillMissingContactName?: boolean;
}

/** Append to Note / Tags without clobbering what the row already carries.
 *  Several transforms write both, so the joining lives in one place. */
function appendNote(record: Record<string, string>, parts: string[]): void {
  const existing = (record['Note'] ?? '').trim();
  record['Note'] = [existing, ...parts].filter(Boolean).join(' | ');
}

function appendTags(record: Record<string, string>, tags: string[]): void {
  const existing = (record['Tags'] ?? '').trim();
  record['Tags'] = [existing, ...tags].filter(Boolean).join(',');
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
    moveInvalidContactToNotes = false,
    fillMissingContactName = false,
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

  // Which rows carry anything Shopify would store, judged HERE — before the
  // transforms below write their own Note and Tags. Read any later and a blank
  // line in the middle of the CSV looks substantial because we just wrote
  // "Invalid email: ..." into it. fillMissingContactName consults this.
  const hadSubstance = new Set<number>();
  for (const row of templateRows) {
    if (!isRowFullyEmpty(row.record)) hadSubstance.add(row.rowNumber);
  }

  // Strip values Shopify rejects outright into Note, so the row imports without
  // them instead of failing whole. Runs BEFORE the duplicate grouping below: an
  // email that has already been cleared cannot form a duplicate group, so the
  // report never shows a group number against an empty cell. It also lowers the
  // row's completeness score, which is correct — a row that just lost its email
  // is a worse keeper than one that kept it.
  const invalidMoved = new Set<number>();
  if (moveInvalidContactToNotes) {
    for (const row of templateRows) {
      const record = row.record;
      const moved: string[] = [];
      const tags: string[] = [];

      const email = (record['Email'] ?? '').trim();
      if (email && emailProblem(email)) {
        moved.push(`Invalid email: ${email}`);
        tags.push('InvalidEmailNotes');
        record['Email'] = '';
      }
      const phone = (record['Phone'] ?? '').trim();
      if (phone && phoneProblem(phone)) {
        moved.push(`Invalid phone: ${phone}`);
        tags.push('InvalidPhoneNotes');
        record['Phone'] = '';
      }

      if (moved.length > 0) {
        appendNote(record, moved);
        appendTags(record, tags);
        invalidMoved.add(row.rowNumber);
      }
    }
  }
  const namesFilled = new Set<number>();

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
        appendNote(record, moved);
        // Tag the stripped rows (never the keeper) so they're filterable in
        // Shopify admin after import
        appendTags(record, dupTags);
      }
    }

    // LAST of the row transforms, after everything above that can empty a row.
    // Shopify rejects a customer with no name, email or phone outright, so a
    // placeholder First Name is the difference between importing the row's
    // address, tags and notes and losing them. Guarded two ways: the row must
    // still have no identity field, and it must have carried real data before
    // these transforms ran — a blank CSV line stays a MissingContact error
    // instead of becoming a customer conjured out of a stray newline. The row
    // number keeps them apart in the admin; the tag makes them filterable and
    // reachable by the QA cleanup route.
    if (fillMissingContactName) {
      const hasIdentity = ['First Name', 'Last Name', 'Email', 'Phone'].some(
        (field) => (record[field] ?? '').trim() !== '',
      );
      if (!hasIdentity && hadSubstance.has(row.rowNumber)) {
        record['First Name'] = `Unknown ${row.rowNumber}`;
        appendTags(record, ['NoContactInfo']);
        namesFilled.add(row.rowNumber);
      }
    }

    if (heliosMigratedTag) {
      const existing = record['Tags'] ?? '';
      // Re-running a file that was already migrated is the normal case, so the
      // tag is usually already in the CSV. Appending it blindly wrote
      // "Individual,HeliosMigrated,HeliosMigrated" into the Shopify Template
      // sheet — the file the operator hands over. Shopify tags are
      // case-insensitive, so compare that way.
      const alreadyTagged = existing
        .split(',')
        .some((t) => t.trim().toLowerCase() === HELIOS_TAG.toLowerCase());
      if (!alreadyTagged) {
        record['Tags'] = existing ? `${existing},${HELIOS_TAG}` : HELIOS_TAG;
      }
    }
  }

  return {
    rows: templateRows,
    emailDupes,
    phoneDupes,
    anyMerges,
    fixMap,
    invalidMoved,
    namesFilled,
  };
}
