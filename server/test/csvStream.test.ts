import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CsvParseError } from '../src/errors';
import { parseCsvFile } from '../src/services/csvParser.service';
import { parseProductCsvFile } from '../src/services/productCsvParser';

// ─────────────────────────────────────────────────────────────────────────────
// CSV FILE STREAMS: a read error rejects cleanly; the file is always closed.
//
// Both parsers used input.pipe(parser). pipe() does not forward the source's
// errors and nothing listened for them, so a temp CSV that vanished (ENOENT) or
// was locked (EPERM/EBUSY) raised an unhandled 'error' event — the process
// exited. And when the parser rejected the file midway the ReadStream was never
// destroyed: a leaked fd, and on Windows an unlinked merchant CSV that stays
// delete-pending until the server restarts. Customers and products are twins, so
// every case runs against both.
// ─────────────────────────────────────────────────────────────────────────────

const PARSERS = [
  ['customer', parseCsvFile],
  ['product', parseProductCsvFile],
] as const;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-csv-stream-'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(PARSERS)('%s CSV file parsing', (_name, parseFile) => {
  it('rejects a missing file without crashing the process', async () => {
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);
    try {
      const missing = path.join(tmpDir, 'does-not-exist.csv');
      const err = await parseFile(missing).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      // A read failure is ours, not the user's file — not a CsvParseError.
      expect(err).not.toBeInstanceOf(CsvParseError);
      // Let any stray 'error' emission surface before asserting it did not.
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });

  it('closes the source stream when the CSV is malformed midway', async () => {
    // A bad row early, then enough padding (~4 MB) that the ReadStream is still
    // mid-file when the parser gives up — otherwise autoClose at EOF would hide a leak.
    const file = path.join(tmpDir, `malformed-${_name}.csv`);
    const padding = 'h,x\n'.repeat(1_000_000);
    fs.writeFileSync(file, `Handle,Email\nh,a@example.com,EXTRA\n${padding}`);

    const streams: fs.ReadStream[] = [];
    const real = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((...args: Parameters<typeof real>) => {
      const stream = real(...args);
      streams.push(stream);
      return stream;
    }) as typeof fs.createReadStream);

    await expect(parseFile(file)).rejects.toBeInstanceOf(CsvParseError);

    expect(streams).toHaveLength(1);
    const [stream] = streams;
    expect(stream.destroyed).toBe(true);
    if (!stream.closed) await new Promise((resolve) => stream.once('close', resolve));
    expect(stream.closed).toBe(true);

    // And the file can actually go away (Windows refuses while an fd is open
    // without share-delete, and leaves it delete-pending with one).
    fs.unlinkSync(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('still parses a good file', async () => {
    const file = path.join(tmpDir, `good-${_name}.csv`);
    fs.writeFileSync(file, 'Handle,Email\nh,a@example.com\n');
    try {
      const parsed = await parseFile(file);
      expect(parsed.headers).toEqual(['Handle', 'Email']);
      expect(parsed.rows).toHaveLength(1);
    } finally {
      fs.unlinkSync(file);
    }
  });
});
