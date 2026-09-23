import { describe, expect, it } from 'vitest';
import { buildProductFiles, buildProductSetInput } from '../src/services/productImport.service';
import { ProductGroup } from '../src/types';

function group(handle: string, records: Record<string, string>[]): ProductGroup {
  return {
    handle,
    rows: records.map((r, i) => {
      const record = { Handle: handle, ...r };
      return { rowNumber: i + 2, original: record, normalized: record };
    }),
  };
}

describe('buildProductFiles', () => {
  // A real migration file had 37 products rejected with "File original source missing
  // from the product files input" because a Variant Image was not also an Image Src.
  it('adds a Variant Image that is not an Image Src as a product file', () => {
    const files = buildProductFiles([
      { 'Image Src': 'https://x/a.jpg', 'Image Position': '1', 'Variant Image': 'https://x/a.jpg' },
      { 'Variant Image': 'https://x/only-variant.jpg' },
    ]);
    expect(files.map((f) => f.originalSource)).toEqual(['https://x/a.jpg', 'https://x/only-variant.jpg']);
  });

  it('does not duplicate a URL used as both Image Src and Variant Image', () => {
    const files = buildProductFiles([
      { 'Variant Image': 'https://x/b.jpg' },
      { 'Image Src': 'https://x/b.jpg', 'Image Position': '1' },
    ]);
    expect(files).toEqual([{ originalSource: 'https://x/b.jpg', contentType: 'IMAGE' }]);
  });
});

describe('buildProductSetInput', () => {
  it('gives every variant file a matching product files entry', () => {
    const input = buildProductSetInput(
      group('xcsg', [
        { Title: 'XCSG', 'Option1 Name': 'Size', 'Option1 Value': '1/4', 'Image Src': 'https://x/1.jpg', 'Variant Image': 'https://x/1.jpg' },
        { 'Option1 Value': '3/8', 'Variant Image': 'https://x/v2.jpg' },
      ]),
      'run-1',
    ) as { files: { originalSource: string }[]; variants: { file?: { originalSource: string } }[] };
    const fileUrls = new Set(input.files.map((f) => f.originalSource));
    for (const v of input.variants) {
      if (v.file) expect(fileUrls.has(v.file.originalSource)).toBe(true);
    }
  });
});

// The builder sends what Shopify's admin CSV import would store, so the test
// import agrees with the real one (observed 2026-09-22).
describe('buildProductSetInput matches the admin CSV import', () => {
  type Input = {
    status: string;
    productOptions: { name: string; values: { name: string }[] }[];
    variants: Record<string, unknown>[];
    metafields?: { namespace: string; key: string }[];
  };
  const build = (records: Record<string, string>[], defined?: Set<string>) =>
    buildProductSetInput(group('p', records), 'run-1', 'gid://shopify/Location/1', defined) as unknown as Input;

  it('fills a blank option value in as "Default Title"', () => {
    const input = build([
      { Title: 'P', 'Option1 Name': 'Size', 'Option1 Value': 'S', 'Variant SKU': 'A' },
      { 'Option1 Value': '', 'Variant SKU': 'B' },
    ]);
    expect(input.productOptions[0].values.map((v) => v.name)).toEqual(['S', 'Default Title']);
    expect(input.variants[1].optionValues).toEqual([{ optionName: 'Size', name: 'Default Title' }]);
  });

  it('reads money, grams and quantity the way the admin does', () => {
    const [v] = build([
      {
        Title: 'P',
        'Variant Price': '$1,000.00',
        'Variant Compare At Price': '10 USD',
        'Cost per item': '10,50',
        'Variant Grams': '100g',
        'Variant Inventory Qty': '1.5',
      },
    ]).variants as {
      price: string;
      compareAtPrice: string;
      inventoryItem: { cost: string; measurement: { weight: { value: number } } };
      inventoryQuantities: { quantity: number }[];
    }[];
    expect(v.price).toBe('1000.00');
    expect(v.compareAtPrice).toBe('10.00');
    expect(v.inventoryItem.cost).toBe('10.50');
    expect(v.inventoryItem.measurement.weight.value).toBe(100);
    expect(v.inventoryQuantities[0].quantity).toBe(1);
  });

  it('passes values the admin rejects through, so productSet rejects that product too', () => {
    const input = build([
      { Title: 'P', Status: 'live', 'Variant Grams': 'heavy', 'Variant Inventory Policy': 'maybe' },
    ]);
    const v = input.variants[0] as { inventoryPolicy: string; inventoryItem: { measurement: { weight: { value: unknown } } } };
    expect(input.status).toBe('LIVE');
    expect(v.inventoryPolicy).toBe('MAYBE');
    expect(v.inventoryItem.measurement.weight.value).toBe('heavy');
  });

  it('sends a blank policy through only when the column exists', () => {
    const withColumn = build([{ Title: 'P', 'Variant Inventory Policy': '' }]).variants[0];
    const without = build([{ Title: 'P' }]).variants[0];
    expect(withColumn.inventoryPolicy).toBe('');
    expect(without.inventoryPolicy).toBeUndefined();
  });

  // Option3 with no Option2: the admin rejects it. Filling the shifted option's
  // blank column in as Default Title would import it instead (seen on store 5).
  it('leaves an option across a gap with no values, so productSet rejects it', () => {
    const input = build([{ Title: 'P', 'Option1 Name': 'Size', 'Option1 Value': 'S', 'Option3 Name': 'Color', 'Option3 Value': 'Red' }]);
    expect(input.productOptions.map((o) => [o.name, o.values.length])).toEqual([['Size', 1], ['Color', 0]]);
  });

  it('accepts unlisted and any-case status', () => {
    expect(build([{ Title: 'P', Status: 'unlisted' }]).status).toBe('UNLISTED');
    expect(build([{ Title: 'P', Status: 'Active' }]).status).toBe('ACTIVE');
  });

  it('drops a metafield with no definition on the store, as the admin does', () => {
    const records = [
      {
        Title: 'P',
        'Fabric (product.metafields.custom.fabric)': 'Cotton',
        'Nope (product.metafields.custom.no_def)': 'x',
      },
    ];
    expect(build(records, new Set(['custom.fabric'])).metafields).toEqual([
      { namespace: 'custom', key: 'fabric', value: 'Cotton' },
    ]);
    // Definitions could not be read: send everything, as before.
    expect(build(records).metafields).toHaveLength(2);
  });
});
