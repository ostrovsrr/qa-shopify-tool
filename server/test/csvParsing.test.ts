import { describe, expect, it } from 'vitest';
import { parseCsvBuffer } from '../src/services/csvParser.service';
import { parseProductCsvBuffer, productHandleTracker } from '../src/services/productCsvParser';

describe('CSV structure validation', () => {
  it('preserves headers for a header-only customer CSV', async () => {
    const parsed = await parseCsvBuffer(Buffer.from(' Email ,Phone\n'));
    expect(parsed.headers).toEqual(['Email', 'Phone']);
    expect(parsed.rows).toEqual([]);
  });

  it('rejects duplicate headers before one value can overwrite the other', async () => {
    await expect(
      parseCsvBuffer(Buffer.from('Email,email\na@example.com,b@example.com\n')),
    ).rejects.toThrow(/duplicate column name "email"/i);
  });

  it('rejects unnamed headers', async () => {
    await expect(parseCsvBuffer(Buffer.from('Email, ,Phone\na@example.com,x,123\n'))).rejects.toThrow(
      /non-empty header/i,
    );
  });

  it('rejects extra cells instead of silently discarding customer data', async () => {
    await expect(parseCsvBuffer(Buffer.from('Email,Phone\na@example.com,123,LOST\n'))).rejects.toThrow(
      /record length|columns/i,
    );
  });

  it('still accepts omitted trailing cells as empty values', async () => {
    const parsed = await parseCsvBuffer(Buffer.from('Email,Phone\na@example.com\n'));
    expect(parsed.rows[0].original).toEqual({ Email: 'a@example.com', Phone: '' });
  });

  it('applies the same header safeguards to product CSVs', async () => {
    await expect(
      parseProductCsvBuffer(Buffer.from('Handle,Handle\na,duplicate\n')),
    ).rejects.toThrow(/duplicate column name/i);
  });

  // The reports label rows with productHandleTracker while paging them from the
  // DB; it must put every row in the product groupByHandle (and so the
  // pre-check and the import) put it in.
  it('labels each product row with the product groupByHandle puts it in', async () => {
    const parsed = await parseProductCsvBuffer(
      Buffer.from('Handle,Title\n,orphan\nalpha,Alpha\n,alpha image\nbeta,Beta\n ,beta image\nalpha,alpha again\n'),
    );
    const productOf = productHandleTracker();
    const labelled = parsed.rows.map((r) => [r.rowNumber, productOf(r.original)]);
    expect(labelled).toEqual([
      [2, ''],
      [3, 'alpha'],
      [4, 'alpha'],
      [5, 'beta'],
      [6, 'beta'],
      [7, 'alpha'],
    ]);
    const grouped = new Map<number, string>();
    for (const g of parsed.groups) for (const r of g.rows) grouped.set(r.rowNumber, g.handle);
    for (const [rowNumber, handle] of labelled) {
      expect(grouped.get(rowNumber as number) ?? '').toBe(handle);
    }
  });

  it('keeps product values trimmed whether or not a row needed trimming', async () => {
    const parsed = await parseProductCsvBuffer(Buffer.from('Handle,Title\nalpha,Alpha\n beta ,Beta \n'));
    expect(parsed.rows[0].normalized).toEqual({ Handle: 'alpha', Title: 'Alpha' });
    expect(parsed.rows[1].normalized).toEqual({ Handle: 'beta', Title: 'Beta' });
    expect(parsed.rows[1].original).toEqual({ Handle: ' beta ', Title: 'Beta ' });
  });

  it('rejects an empty file with a user-facing parse error', async () => {
    await expect(parseCsvBuffer(Buffer.alloc(0))).rejects.toThrow(/empty|header row/i);
  });
});
