import { describe, expect, it } from 'vitest';
import { assertNotProductCsv } from '../src/services/csvParser.service';

// Regression: ISSUE-001 — a Shopify product CSV uploaded to the customers
// section parsed fine, mapped 1 of 19 columns, and reported "MissingContact —
// add at least a First Name" on every row, then offered to import it.
// Found by /qa on 2026-09-04
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-04.md

const PRODUCT_HEADERS = [
  'Handle',
  'Title',
  'Body (HTML)',
  'Vendor',
  'Type',
  'Tags',
  'Published',
  'Option1 Name',
  'Option1 Value',
  'Variant SKU',
  'Variant Price',
  'Image Src',
];

const CUSTOMER_HEADERS = [
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Accepts Email Marketing',
  'Tags',
  'Note',
  'Default Address City',
];

describe('wrong-section CSV guard', () => {
  it('rejects a Shopify product CSV and names the section to use', () => {
    expect(() => assertNotProductCsv(PRODUCT_HEADERS)).toThrow(/Products section/i);
  });

  it('accepts a customer CSV', () => {
    expect(() => assertNotProductCsv(CUSTOMER_HEADERS)).not.toThrow();
  });

  it('matches headers regardless of case and surrounding space', () => {
    const messy = PRODUCT_HEADERS.map((h) => ` ${h.toUpperCase()} `);
    expect(() => assertNotProductCsv(messy)).toThrow(/Products section/i);
  });

  // The false-reject cases matter more than the false-accept: a customer file
  // that trips this guard blocks real work, while a product file that slips
  // through only costs the user a trip back to the upload screen.
  it('accepts a customer CSV whose "Handle" is a social handle', () => {
    expect(() => assertNotProductCsv(['Handle', 'Email', 'First Name'])).not.toThrow();
  });

  it('accepts a Handle column with too few product markers to be conclusive', () => {
    // Vendor alone is one marker; the guard needs two before it acts.
    expect(() => assertNotProductCsv(['Handle', 'Vendor', 'Notes'])).not.toThrow();
  });

  it('lets a product-shaped file through once it carries any customer identity field', () => {
    expect(() => assertNotProductCsv([...PRODUCT_HEADERS, 'Email'])).not.toThrow();
  });

  it('ignores Tags and Note, which both templates share', () => {
    expect(() => assertNotProductCsv(['Handle', 'Tags', 'Note'])).not.toThrow();
  });

  it('does not fire on a CSV with no Handle column at all', () => {
    expect(() => assertNotProductCsv(['Body (HTML)', 'Vendor', 'Variant SKU'])).not.toThrow();
  });
});
