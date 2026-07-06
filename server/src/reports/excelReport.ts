import ExcelJS from 'exceljs';
import prisma from '../db/prisma';
import {
  applyMappingToRecord,
  KEEP_COLUMN,
  resolveMappingTarget,
  SHOPIFY_COLUMNS,
} from '../services/columnMapping.service';
import { CustomerValidationIssue, Severity } from '../types';
import { canonicalPhone } from '../utils/normalize';
import { AutoFixEntry, computeAutoFixes } from './autoFix';

const SEVERITY_COLOURS: Record<Severity, string> = {
  Error: 'FFFEE2E2',
  Warning: 'FFFEF3C7',
  Info: 'FFE0F2FE',
};

const HEADER_COLOURS: Record<string, string> = {
  Summary: 'FF1E3A5F',
  Errors: 'FFB91C1C',
  Warnings: 'FFB45309',
  Info: 'FF0369A1',
  'Full Uploaded File': 'FF065F46',
  'Shopify Template': 'FF004C3F',
};

export async function generateExcelReport(validationId: string): Promise<Buffer> {
  const run = await prisma.validationRun.findUnique({
    where: { id: validationId },
    include: {
      issues: { orderBy: { rowNumber: 'asc' } },
      originalRows: { orderBy: { rowNumber: 'asc' } },
    },
  });

  if (!run) throw new Error(`Validation run "${validationId}" not found.`);

  // Cast to include JSON fields that Prisma's stale generated types don't yet expose
  const runData = run as typeof run & {
    originalColumns: unknown;
    columnMapping: unknown;
    heliosMigratedTag: boolean;
    moveDuplicatesToNotes: boolean;
    originalRows: { rowNumber: number; data: unknown }[];
  };

  const issues: CustomerValidationIssue[] = run.issues.map((issue) => ({
    rowNumber: issue.rowNumber,
    column: issue.columnName,
    severity: issue.severity as Severity,
    issueType: issue.issueType,
    currentValue: issue.currentValue ?? '',
    message: issue.message,
    suggestedFix: issue.suggestedFix ?? '',
  }));

  const originalColumns: string[] = Array.isArray(runData.originalColumns)
    ? (runData.originalColumns as string[])
    : [];

  const columnMapping: Record<string, string> =
    runData.columnMapping &&
    typeof runData.columnMapping === 'object' &&
    !Array.isArray(runData.columnMapping)
      ? (runData.columnMapping as Record<string, string>)
      : {};

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shopify CSV QA Tool';
  workbook.created = new Date();

  const autoFixes = computeAutoFixes(runData.originalRows, columnMapping);
  const heliosMigratedTag: boolean = runData.heliosMigratedTag ?? false;
  const moveDuplicatesToNotes: boolean = runData.moveDuplicatesToNotes ?? false;

  addSummarySheet(workbook, run, issues);
  addIssuesSheet(workbook, 'Errors', issues.filter((i) => i.severity === 'Error'));
  addIssuesSheet(workbook, 'Warnings', issues.filter((i) => i.severity === 'Warning'));
  addFullUploadedFileSheet(workbook, originalColumns, runData.originalRows);
  addShopifyTemplateSheet(
    workbook,
    columnMapping,
    runData.originalRows,
    autoFixes,
    heliosMigratedTag,
    moveDuplicatesToNotes,
  );

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------

function styleHeader(row: ExcelJS.Row, bgArgb: string) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  row.height = 20;
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  run: {
    id: string;
    fileName: string;
    totalRows: number;
    errors: number;
    warnings: number;
    info: number;
    createdAt: Date;
  },
  issues: CustomerValidationIssue[],
) {
  const sheet = workbook.addWorksheet('Summary');
  sheet.columns = [{ width: 28 }, { width: 44 }];

  const title = sheet.addRow(['Shopify CSV QA Tool — Validation Report']);
  title.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
  sheet.addRow([]);

  const kv = (label: string, value: string | number) => {
    const r = sheet.addRow([label, value]);
    r.getCell(1).font = { bold: true };
  };

  kv('File Name', run.fileName);
  kv('Validation ID', run.id);
  kv('Total Rows', run.totalRows);
  kv('Total Errors', run.errors);
  kv('Total Warnings', run.warnings);
  kv('Total Info', run.info);
  kv('Created Date', run.createdAt.toISOString());
  sheet.addRow([]);

  const breakdownTitle = sheet.addRow(['Issue Type Breakdown']);
  breakdownTitle.getCell(1).font = { bold: true, size: 12 };

  const headerRow = sheet.addRow(['Issue Type', 'Count', 'Severity']);
  styleHeader(headerRow, HEADER_COLOURS['Summary']);
  sheet.getColumn(3).width = 14;

  const counts = new Map<string, { count: number; severity: Severity }>();
  for (const issue of issues) {
    const existing = counts.get(issue.issueType);
    if (existing) {
      existing.count++;
    } else {
      counts.set(issue.issueType, { count: 1, severity: issue.severity });
    }
  }

  for (const [issueType, { count, severity }] of [...counts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const r = sheet.addRow([issueType, count, severity]);
    r.getCell(3).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: SEVERITY_COLOURS[severity] },
    };
  }
}

function addIssuesSheet(
  workbook: ExcelJS.Workbook,
  sheetName: 'Errors' | 'Warnings' | 'Info',
  issues: CustomerValidationIssue[],
) {
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = [
    { header: 'Row Number', key: 'rowNumber', width: 12 },
    { header: 'Column', key: 'column', width: 26 },
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'Issue Type', key: 'issueType', width: 30 },
    { header: 'Current Value', key: 'currentValue', width: 32 },
    { header: 'Message', key: 'message', width: 55 },
    { header: 'Suggested Fix', key: 'suggestedFix', width: 55 },
  ];

  styleHeader(sheet.getRow(1), HEADER_COLOURS[sheetName]);

  for (const issue of issues) {
    const row = sheet.addRow({
      rowNumber: issue.rowNumber,
      column: issue.column,
      severity: issue.severity,
      issueType: issue.issueType,
      currentValue: issue.currentValue,
      message: issue.message,
      suggestedFix: issue.suggestedFix,
    });
    const colour = SEVERITY_COLOURS[issue.severity];
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colour } };
    });
  }

  sheet.autoFilter = { from: 'A1', to: 'G1' };
}

function addFullUploadedFileSheet(
  workbook: ExcelJS.Workbook,
  originalColumns: string[],
  originalRows: { rowNumber: number; data: unknown }[],
) {
  const sheet = workbook.addWorksheet('Full Uploaded File');

  if (originalColumns.length === 0 || originalRows.length === 0) {
    sheet.addRow(['No uploaded file data available.']);
    return;
  }

  const allColumns = ['Row Number', ...originalColumns];
  sheet.columns = allColumns.map((col) => ({
    header: col,
    key: col,
    width: col === 'Row Number' ? 12 : 22,
  }));

  styleHeader(sheet.getRow(1), HEADER_COLOURS['Full Uploaded File']);

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const rowData: Record<string, string | number> = { 'Row Number': origRow.rowNumber };
    for (const col of originalColumns) {
      rowData[col] = data[col] ?? '';
    }
    sheet.addRow(rowData);
  }

  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(allColumns.length)}1` };
}

const AUTO_FIX_GREEN = 'FFD1FAE5';

const HELIOS_TAG = 'HeliosMigrated';

function addShopifyTemplateSheet(
  workbook: ExcelJS.Workbook,
  columnMapping: Record<string, string>,
  originalRows: { rowNumber: number; data: unknown }[],
  autoFixes: AutoFixEntry[] = [],
  heliosMigratedTag = false,
  moveDuplicatesToNotes = false,
) {
  const sheet = workbook.addWorksheet('Shopify Template');

  if (Object.keys(columnMapping).length === 0 || originalRows.length === 0) {
    sheet.addRow(['No column mapping was applied for this validation run.']);
    return;
  }

  // Determine which Shopify columns are present, in canonical SHOPIFY_COLUMNS order.
  // Append targets ("Add to Tags"/"Add to Note") count as Tags/Note.
  const mappedTargets = new Set(Object.values(columnMapping).map(resolveMappingTarget));
  const shopifyColumns = SHOPIFY_COLUMNS.filter((col) => mappedTargets.has(col));

  // If appending HeliosMigrated tag and Tags isn't already mapped, add it as a trailing column
  const tagsAlreadyMapped = shopifyColumns.includes('Tags');
  const effectiveColumns: string[] =
    heliosMigratedTag && !tagsAlreadyMapped ? [...shopifyColumns, 'Tags'] : [...shopifyColumns];

  // Reverse map (Shopify column → source CSV column, last one wins) — only used
  // for the duplicate-group lookups below; cell values go through
  // applyMappingToRecord so append targets are honoured.
  const reverseMap: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(columnMapping)) {
    reverseMap[tgt] = src;
  }

  // Completeness score per row: how many mapped source cells are non-empty.
  // Used to pick which row of a duplicate group keeps its email/phone when
  // moving duplicates to Note — the most-filled record wins.
  const mappedSourceCols = Object.keys(columnMapping);
  const completeness = new Map<number, number>();
  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    let score = 0;
    for (const src of mappedSourceCols) {
      if ((data[src] ?? '').trim() !== '') score++;
    }
    completeness.set(origRow.rowNumber, score);
  }

  // Assign duplicate-group numbers per row, grouped by a Shopify field's value.
  // Matches the DuplicateEmail/DuplicatePhone validator normalization so the
  // report stays consistent. `groups` maps rowNumber → group # (only for
  // duplicates); `repeats` holds every group row except the keeper (the
  // most-filled record, ties broken by earliest row) — those are the rows whose
  // duplicated value is moved to Note when the option is on.
  const buildDuplicateGroups = (
    field: string,
    normalize: (value: string) => string,
  ): { groups: Map<number, number>; repeats: Set<number> } => {
    const groups = new Map<number, number>();
    const repeats = new Set<number>();
    const srcCol = reverseMap[field];
    if (srcCol === undefined) return { groups, repeats };

    const order: string[] = [];
    const byValue = new Map<string, number[]>();
    for (const origRow of originalRows) {
      const data = origRow.data as Record<string, string>;
      const normalized = normalize(data[srcCol] ?? '');
      if (!normalized) continue;
      if (!byValue.has(normalized)) {
        byValue.set(normalized, []);
        order.push(normalized);
      }
      byValue.get(normalized)!.push(origRow.rowNumber);
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
  };

  const emailDupes = buildDuplicateGroups('Email', (v) => v.trim().toLowerCase());
  const phoneDupes = buildDuplicateGroups('Phone', canonicalPhone);
  const emailGroups = emailDupes.groups;
  const phoneGroups = phoneDupes.groups;

  // Moving duplicates needs Note (moved value) and Tags (DuplicateEmailNotes /
  // DuplicatePhoneNotes marker) columns even when neither was mapped
  if (moveDuplicatesToNotes && (emailDupes.repeats.size > 0 || phoneDupes.repeats.size > 0)) {
    if (!effectiveColumns.includes('Note')) effectiveColumns.push('Note');
    if (!effectiveColumns.includes('Tags')) effectiveColumns.push('Tags');
  }

  // "Keep" columns pass through as trailing columns under their original names
  const keptColumns = Object.entries(columnMapping)
    .filter(([, tgt]) => tgt === KEEP_COLUMN)
    .map(([src]) => src)
    .filter((src) => !effectiveColumns.includes(src));
  effectiveColumns.push(...keptColumns);

  // Duplicate-group columns lead, then Row Number, then the Shopify columns
  sheet.columns = [
    { header: 'Duplicate Group # (Email)', key: 'dupEmailGroup', width: 22 },
    { header: 'Duplicate Group # (Phone)', key: 'dupPhoneGroup', width: 22 },
    { header: 'Row Number', key: 'rowNumber', width: 12 },
    ...effectiveColumns.map((col) => ({ header: col, key: col, width: 26 })),
  ];

  styleHeader(sheet.getRow(1), HEADER_COLOURS['Shopify Template']);

  // Highlight the two duplicate-group header cells in red
  const headerRow = sheet.getRow(1);
  for (const c of [1, 2]) {
    headerRow.getCell(c).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: HEADER_COLOURS['Errors'] },
    };
  }

  // Build fix lookup: rowNumber → shopify column → fixed value
  const fixMap = new Map<number, Map<string, string>>();
  for (const fix of autoFixes) {
    if (!fixMap.has(fix.rowNumber)) fixMap.set(fix.rowNumber, new Map());
    fixMap.get(fix.rowNumber)!.set(fix.field, fix.fixedValue);
  }

  for (const origRow of originalRows) {
    const data = origRow.data as Record<string, string>;
    const rowFixes = fixMap.get(origRow.rowNumber);
    const rowData: Record<string, string | number> = {
      rowNumber: origRow.rowNumber,
      dupEmailGroup: emailGroups.get(origRow.rowNumber) ?? '',
      dupPhoneGroup: phoneGroups.get(origRow.rowNumber) ?? '',
    };

    // Only mapped source columns contribute values; unmapped columns are ignored
    const mappedSources: Record<string, string> = {};
    for (const src of Object.keys(columnMapping)) mappedSources[src] = data[src] ?? '';
    const mapped = applyMappingToRecord(mappedSources, columnMapping);

    for (const shopifyCol of effectiveColumns) {
      rowData[shopifyCol] = rowFixes?.get(shopifyCol) ?? mapped[shopifyCol] ?? '';
    }

    // Strip the duplicated identifier from every group row except the keeper
    // (most-filled record) and stash it in Note, so Shopify accepts the
    // customer instead of rejecting it as "taken". Only the duplicated field
    // is stripped — a row that's only an email duplicate keeps its phone, and
    // vice versa.
    if (moveDuplicatesToNotes) {
      const moved: string[] = [];
      const dupTags: string[] = [];
      if (emailDupes.repeats.has(origRow.rowNumber)) {
        const email = String(rowData['Email'] ?? '');
        if (email) {
          moved.push(`Duplicate email: ${email}`);
          dupTags.push('DuplicateEmailNotes');
          rowData['Email'] = '';
        }
      }
      if (phoneDupes.repeats.has(origRow.rowNumber)) {
        const phone = String(rowData['Phone'] ?? '');
        if (phone) {
          moved.push(`Duplicate phone: ${phone}`);
          dupTags.push('DuplicatePhoneNotes');
          rowData['Phone'] = '';
        }
      }
      if (moved.length > 0) {
        const existingNote = String(rowData['Note'] ?? '').trim();
        rowData['Note'] = [existingNote, ...moved].filter(Boolean).join(' | ');
        // Tag the stripped rows (never the keeper) so they're filterable in
        // Shopify admin after import
        const existingTags = String(rowData['Tags'] ?? '').trim();
        rowData['Tags'] = [existingTags, ...dupTags].filter(Boolean).join(',');
      }
    }

    if (heliosMigratedTag) {
      const existing = rowData['Tags'] as string ?? '';
      rowData['Tags'] = existing ? `${existing},${HELIOS_TAG}` : HELIOS_TAG;
    }

    const excelRow = sheet.addRow(rowData);

    if (rowFixes) {
      effectiveColumns.forEach((shopifyCol, colIdx) => {
        if (rowFixes.has(shopifyCol)) {
          // +4: cols 1-2 are duplicate-group columns, col 3 is Row Number
          const cell = excelRow.getCell(colIdx + 4);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AUTO_FIX_GREEN } };
        }
      });
    }
  }

  // +3 for the two duplicate-group columns and the Row Number column
  sheet.autoFilter = { from: 'A1', to: `${columnIndexToLetter(effectiveColumns.length + 3)}1` };
}

function columnIndexToLetter(index: number): string {
  let letter = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    index = Math.floor((index - 1) / 26);
  }
  return letter;
}
