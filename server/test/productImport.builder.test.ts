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
