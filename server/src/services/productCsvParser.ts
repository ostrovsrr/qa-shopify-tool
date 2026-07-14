import fs from 'fs';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import { ParsedProductCsv, ProductCsvRow, ProductGroup } from '../types';
import { isRowFullyEmpty, normalizeRecord } from '../utils/normalize';

// The Shopify product CSV groups rows by Handle: the first row of a Handle carries
// the product-level fields, and rows sharing the Handle add variants/images. We
// parse the raw CSV, then group contiguous-or-not rows by Handle preserving first-
// seen order, so the import unit is a product (one group), not a CSV row.

/** Read the first non-empty value among the candidate column names (handles the
 *  "Body (HTML)" vs "Body HTML" style template variations). */
export function col(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const v = row[name];
    if (v !== undefined && v.trim() !== '') return v.trim();
  }
  return '';
}

// Metafield columns in the source CSV are headed
//   "<Display label> (product.metafields.<namespace>.<key>)"
// e.g. "custom.top_speed (product.metafields.custom.top_speed)" or
//      "Color (product.metafields.shopify.color-pattern)".
// The authoritative identity is the parenthesized path; the leading label is
// only a human display name and is ignored. There is NO type in the header —
// productSet infers it from the metafield definition already on the store, so
// the definitions must exist first (create them with the metafields-creator
// CLI). namespace/key are non-dotted (alphanumeric + - _), so we match each as
// a run of non-dot, non-paren characters.
const METAFIELD_HEADER_RE =
  /\(\s*product\.metafields\.([^.()\s]+)\.([^.()\s]+)\s*\)/i;

export interface ParsedMetafield {
  namespace: string;
  key: string;
  value: string;
}

/** Extract product-level metafields from a row (the product's first row) by
 *  scanning its column keys for the metafield header pattern. Empty cells are
 *  skipped so we don't send blank values Shopify would reject. */
export function extractMetafields(row: Record<string, string>): ParsedMetafield[] {
  const out: ParsedMetafield[] = [];
  for (const [header, rawValue] of Object.entries(row)) {
    const match = METAFIELD_HEADER_RE.exec(header);
    if (!match) continue;
    const value = (rawValue ?? '').trim();
    if (value === '') continue; // only set metafields that actually have a value
    out.push({ namespace: match[1], key: match[2], value });
  }
  return out;
}

const PARSE_OPTIONS = {
  columns: true,
  skip_empty_lines: false,
  relax_column_count: true,
  cast: false,
  // Strip a leading UTF-8 BOM (Shopify/Excel exports include one). Without
  // this the first header parses as "﻿Handle", so groupByHandle can't
  // find the Handle column → 0 product groups from a non-empty file.
  bom: true,
} as const;

function toParsed(records: Record<string, string>[]): ParsedProductCsv {
  const headers = records.length > 0 ? Object.keys(records[0]) : [];

  // Trim trailing fully-empty rows (common when exporting from spreadsheets).
  let lastNonEmpty = records.length - 1;
  while (lastNonEmpty >= 0 && isRowFullyEmpty(records[lastNonEmpty])) {
    lastNonEmpty--;
  }

  const rows: ProductCsvRow[] = [];
  for (let i = 0; i <= lastNonEmpty; i++) {
    const record = records[i];
    if (isRowFullyEmpty(record)) continue; // skip blank rows mid-file
    rows.push({
      rowNumber: i + 2, // header is line 1
      original: { ...record },
      normalized: normalizeRecord(record),
    });
  }

  return { rows, headers, groups: groupByHandle(rows) };
}

async function parseProductCsvStream(input: Readable): Promise<ParsedProductCsv> {
  const records: Record<string, string>[] = [];
  const parser = input.pipe(parse(PARSE_OPTIONS));

  for await (const record of parser) {
    records.push(record as Record<string, string>);
  }

  return toParsed(records);
}

/** Parse an uploaded product CSV straight off disk. The customer twin is
 *  parseCsvFile in csvParser.service.ts — see uploadFile.ts for why. */
export async function parseProductCsvFile(filePath: string): Promise<ParsedProductCsv> {
  return parseProductCsvStream(fs.createReadStream(filePath));
}

/** In-memory variant, for tests and any caller that already has the bytes. */
export async function parseProductCsvBuffer(buffer: Buffer): Promise<ParsedProductCsv> {
  return parseProductCsvStream(Readable.from(buffer));
}

// Groups rows by Handle, preserving the order each Handle first appears. A row
// with no Handle is attached to the most recent Handle (Shopify exports leave the
// Handle blank on continuation rows in some dialects); a leading row with no
// Handle at all is dropped (nothing to attach it to).
export function groupByHandle(rows: ProductCsvRow[]): ProductGroup[] {
  const groups: ProductGroup[] = [];
  const byHandle = new Map<string, ProductGroup>();
  let currentHandle = '';

  for (const row of rows) {
    const handle = col(row.normalized, 'Handle');
    const key = handle || currentHandle;
    if (!key) continue; // no handle and no preceding group — skip
    currentHandle = key;

    let group = byHandle.get(key);
    if (!group) {
      group = { handle: key, rows: [] };
      byHandle.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }

  return groups;
}
