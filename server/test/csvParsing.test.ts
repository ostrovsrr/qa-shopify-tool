import { describe, expect, it } from 'vitest';
import { parseCsvBuffer } from '../src/services/csvParser.service';
import { parseProductCsvBuffer } from '../src/services/productCsvParser';

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

  it('rejects an empty file with a user-facing parse error', async () => {
    await expect(parseCsvBuffer(Buffer.alloc(0))).rejects.toThrow(/empty|header row/i);
  });
});
