// The rejection probe: one synthetic product per behaviour of Shopify's admin CSV
// import that the tool has to match, each with the verdict OBSERVED on
// rodionteststore5 on 2026-09-22 (results: docs/products/rejection-probe-results.md).
//
//   admin: 'imports'      — the product imports (possibly with the value adjusted)
//          'rejects'      — the product fails, listed in the result email
//          'refuses-file' — the whole file is refused at upload, nothing imports
//
// test/validators/productProbeParity.test.ts holds the pre-check to these
// verdicts: it must flag exactly the cases that do not import. Add a case only
// with a verdict you have seen on a store. Synthetic values only (public repo).

export const LONG = 'L'.repeat(300); // past Shopify's 255-character limits
const IMG = 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png';
export const METAFIELD_COL = 'QA probe (product.metafields.custom.qa_probe_no_def)';

export const HEADERS = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty',
  'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price',
  'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode',
  'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card', 'Variant Image', 'Variant Weight Unit',
  'Cost per item', 'Status', METAFIELD_COL,
];

type Row = Record<string, string>;
export type AdminVerdict = 'imports' | 'rejects' | 'refuses-file';
export interface ProbeCase {
  slug: string;
  admin: AdminVerdict;
  says?: string; // the admin import's own wording, when it has one
  rows: Row[]; // first row gets product-level defaults; later rows are variant/image rows
}

// A plain, valid first row. Each case overrides only what it is probing.
function base(slug: string): Row {
  return {
    Title: `QA probe ${slug}`,
    'Body (HTML)': '<p>Synthetic rejection probe.</p>',
    Vendor: 'QA Probe',
    Type: 'Probe',
    Tags: 'qa-import, qa-probe',
    Published: 'FALSE',
    'Variant SKU': `QAP-${slug}-1`,
    'Variant Price': '10.00',
    'Variant Fulfillment Service': 'manual',
    'Variant Requires Shipping': 'TRUE',
    'Variant Taxable': 'TRUE',
    'Variant Inventory Policy': 'deny',
    'Gift Card': 'FALSE',
    Status: 'draft',
  };
}
const variant = (slug: string, n: number, extra: Row = {}): Row => ({
  'Variant SKU': `QAP-${slug}-${n}`,
  'Variant Price': '10.00',
  'Variant Fulfillment Service': 'manual',
  'Variant Inventory Policy': 'deny',
  ...extra,
});

export const CASES: ProbeCase[] = [
  { slug: 'ok-control', admin: 'imports', rows: [{}] },
  {
    slug: 'dup-default-variant', admin: 'rejects', says: "The variant 'Default Title' already exists.",
    rows: [{}, variant('dup-default-variant', 2)],
  },
  {
    slug: 'dup-option-value', admin: 'rejects', says: "The variant 'M' already exists.",
    rows: [
      { 'Option1 Name': 'Size', 'Option1 Value': 'M' },
      variant('dup-option-value', 2, { 'Option1 Value': 'M' }),
    ],
  },
  {
    // The admin fills the blank in as "Default Title".
    slug: 'blank-option-value', admin: 'imports',
    rows: [
      { 'Option1 Name': 'Size', 'Option1 Value': 'S' },
      variant('blank-option-value', 2, { 'Option1 Value': '' }),
    ],
  },
  { slug: 'option-name-long', admin: 'rejects', says: 'Option name is too long.', rows: [{ 'Option1 Name': LONG, 'Option1 Value': 'S' }] },
  {
    slug: 'option-names-duplicate', admin: 'rejects', says: "Duplicated option name 'Color'",
    rows: [{ 'Option1 Name': 'Color', 'Option1 Value': 'Red', 'Option2 Name': 'Color', 'Option2 Value': 'Blue' }],
  },
  { slug: 'option-name-title', admin: 'imports', rows: [{ 'Option1 Name': 'Title', 'Option1 Value': 'Red' }] },
  {
    slug: 'option-gap', admin: 'rejects', says: "Can't have option Color as option3 without providing option2",
    rows: [{ 'Option1 Name': 'Size', 'Option1 Value': 'S', 'Option3 Name': 'Color', 'Option3 Value': 'Red' }],
  },
  { slug: 'option-value-long', admin: 'rejects', says: 'Option value name is too long.', rows: [{ 'Option1 Name': 'Size', 'Option1 Value': LONG }] },
  // Imports with the metafield silently dropped (no definition on the store).
  { slug: 'metafield-no-definition', admin: 'imports', rows: [{ [METAFIELD_COL]: 'probe value' }] },
  {
    slug: 'gift-card', admin: 'rejects', says: 'Gift card products can only be created after they have been activated',
    rows: [{ 'Gift Card': 'TRUE' }],
  },
  { slug: 'price-text', admin: 'refuses-file', says: '"abc" is not a valid price', rows: [{ 'Variant Price': 'abc' }] },
  { slug: 'price-negative', admin: 'rejects', says: 'Price must be greater than or equal to 0', rows: [{ 'Variant Price': '-5.00' }] },
  { slug: 'compare-at-text', admin: 'refuses-file', says: '"abc" is not a valid price', rows: [{ 'Variant Compare At Price': 'abc' }] },
  { slug: 'cost-text', admin: 'refuses-file', says: '"cheap" is not a valid cost per item', rows: [{ 'Cost per item': 'cheap' }] },
  { slug: 'grams-text', admin: 'rejects', says: "Weight isn't a number.", rows: [{ 'Variant Grams': 'heavy' }] },
  // Imports; the unit is ignored.
  { slug: 'weight-unit-invalid', admin: 'imports', rows: [{ 'Variant Grams': '100', 'Variant Weight Unit': 'stone' }] },
  {
    slug: 'inventory-policy-invalid', admin: 'rejects', says: 'Inventory policy is not included in the list',
    rows: [{ 'Variant Inventory Policy': 'maybe' }],
  },
  // Imports as quantity 1.
  { slug: 'inventory-qty-decimal', admin: 'imports', rows: [{ 'Variant Inventory Tracker': 'shopify', 'Variant Inventory Qty': '1.5' }] },
  {
    slug: 'status-invalid', admin: 'rejects', says: "Status isn't valid. Set the status as active, draft, or archived.",
    rows: [{ Status: 'live' }],
  },
  { slug: 'title-blank', admin: 'rejects', says: 'Title must be specified', rows: [{ Title: '' }] },
  { slug: 'title-long', admin: 'rejects', says: 'Title is too long (maximum is 255 characters)', rows: [{ Title: LONG }] },
  { slug: 'vendor-long', admin: 'rejects', says: 'Vendor is too long (maximum is 255 characters)', rows: [{ Vendor: LONG }] },
  { slug: 'type-long', admin: 'rejects', says: 'Product type is too long (maximum is 255 characters)', rows: [{ Type: LONG }] },
  { slug: 'tag-long', admin: 'rejects', says: 'Product tags is invalid', rows: [{ Tags: `qa-import, qa-probe, ${LONG}` }] },
  { slug: 'sku-long', admin: 'rejects', says: 'SKU is too long (maximum is 255 characters)', rows: [{ 'Variant SKU': LONG }] },
  { slug: 'barcode-long', admin: 'rejects', says: 'Barcode is too long (maximum is 255 characters)', rows: [{ 'Variant Barcode': LONG }] },
  { slug: 'image-not-a-url', admin: 'rejects', says: 'File URL is invalid', rows: [{ 'Image Src': 'not a url' }] },
  // Imports; the image shows as failed. No error anywhere.
  { slug: 'image-unreachable', admin: 'imports', rows: [{ 'Image Src': 'https://example.invalid/missing.jpg' }] },
  {
    slug: 'variant-image-only', admin: 'imports',
    rows: [
      { 'Option1 Name': 'Size', 'Option1 Value': 'S', 'Variant Image': IMG },
      variant('variant-image-only', 2, { 'Option1 Value': 'M' }),
    ],
  },
  { slug: 'compare-at-lower', admin: 'imports', rows: [{ 'Variant Compare At Price': '5.00' }] },

  // ── Value formats (second probe, same day) ─────────────────────────────────
  // Money: the first number in the cell is read; anything with a digit imports.
  { slug: 'price-dollar', admin: 'imports', rows: [{ 'Variant Price': '$10.00' }] }, // → 10.00
  { slug: 'price-thousands', admin: 'imports', rows: [{ 'Variant Price': '1,000.00' }] }, // → 1000.00
  { slug: 'price-decimal-comma', admin: 'imports', rows: [{ 'Variant Price': '10,50' }] }, // → 10.50
  { slug: 'price-three-decimals', admin: 'imports', rows: [{ 'Variant Price': '10.999' }] }, // → 11.00
  { slug: 'price-exponent', admin: 'imports', rows: [{ 'Variant Price': '1e2' }] }, // → 1.00
  { slug: 'price-currency-word', admin: 'imports', rows: [{ 'Variant Price': '10 USD' }] }, // → 10.00
  { slug: 'price-leading-dot', admin: 'imports', rows: [{ 'Variant Price': '.5' }] }, // → 0.50
  { slug: 'compare-at-dollar', admin: 'imports', rows: [{ 'Variant Compare At Price': '$5' }] },
  { slug: 'cost-currency-word', admin: 'imports', rows: [{ 'Cost per item': '5 USD' }] },
  // Grams: a leading number.
  { slug: 'grams-with-unit', admin: 'imports', rows: [{ 'Variant Grams': '100g' }] }, // → 100 g
  { slug: 'grams-thousands', admin: 'imports', rows: [{ 'Variant Grams': '1,000' }] }, // → 1 g (!)
  { slug: 'grams-negative', admin: 'rejects', says: 'Weight must be greater than or equal to 0', rows: [{ 'Variant Grams': '-5' }] },
  // Policy: any case. Blank on a variant row refuses the file (column present).
  { slug: 'policy-capitalised', admin: 'imports', rows: [{ 'Variant Inventory Policy': 'Deny' }] },
  { slug: 'policy-upper', admin: 'imports', rows: [{ 'Variant Inventory Policy': 'CONTINUE' }] },
  { slug: 'policy-leading-space', admin: 'imports', rows: [{ 'Variant Inventory Policy': ' continue' }] },
  {
    slug: 'policy-blank', admin: 'refuses-file', says: 'Inventory policy is not included in the list',
    rows: [{ 'Option1 Name': 'Size', 'Option1 Value': 'S' }, variant('policy-blank', 2, { 'Option1 Value': 'M', 'Variant Inventory Policy': '' })],
  },
  {
    slug: 'policy-blank-image-row', admin: 'imports',
    rows: [{ 'Image Src': IMG }, { 'Image Src': 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-2.png' }],
  },
  // Status: any case; unlisted is valid.
  { slug: 'status-capitalised', admin: 'imports', rows: [{ Status: 'Active' }] },
  { slug: 'status-unlisted', admin: 'imports', rows: [{ Status: 'unlisted' }] },
  // Quantity never fails a product.
  { slug: 'qty-negative', admin: 'imports', rows: [{ 'Variant Inventory Tracker': 'shopify', 'Variant Inventory Qty': '-3' }] },
  { slug: 'qty-text', admin: 'imports', rows: [{ 'Variant Inventory Tracker': 'shopify', 'Variant Inventory Qty': 'ten' }] }, // → 0
];

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function probeHandle(c: ProbeCase): string {
  return `qa-probe-${String(CASES.indexOf(c) + 1).padStart(2, '0')}-${c.slug}`;
}

/** The probe CSV for `cases` (defaults to all), and each product's first line. */
export function renderProbeCsv(cases: ProbeCase[] = CASES): {
  csv: string;
  lines: { line: number; handle: string; c: ProbeCase }[];
} {
  const out: string[] = [HEADERS.map(csvCell).join(',')];
  const lines: { line: number; handle: string; c: ProbeCase }[] = [];
  for (const c of cases) {
    const handle = probeHandle(c);
    c.rows.forEach((overrides, r) => {
      const row: Row = { Handle: handle, ...(r === 0 ? base(c.slug) : {}), ...overrides };
      out.push(HEADERS.map((h) => csvCell(row[h] ?? '')).join(','));
      if (r === 0) lines.push({ line: out.length, handle, c });
    });
  }
  return { csv: out.join('\r\n') + '\r\n', lines };
}
