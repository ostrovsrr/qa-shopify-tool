import { describe, expect, it } from 'vitest';
import { CASES, probeHandle, renderProbeCsv } from '../../scripts/rejectionProbe/cases';
import { parseProductCsvBuffer } from '../../src/services/productCsvParser';
import { FILE_BLOCKING_ISSUE_TYPES, runProductValidation } from '../../src/validators/product';
import { ProductValidationIssue } from '../../src/types';

// The pre-check's promise: a file with no pre-check errors imports every product
// through Shopify's admin CSV import. Each probe case carries the verdict that
// import gave on a real store (scripts/rejectionProbe/cases.ts); the pre-check
// must flag exactly the cases that did not import, with Shopify's own wording.
describe('product pre-check vs observed admin CSV import verdicts', async () => {
  const { groups } = await parseProductCsvBuffer(Buffer.from(renderProbeCsv().csv, 'utf8'));
  const issues = runProductValidation(groups);
  const byHandle = new Map<string, ProductValidationIssue[]>();
  for (const issue of issues) {
    if (!byHandle.has(issue.handle)) byHandle.set(issue.handle, []);
    byHandle.get(issue.handle)!.push(issue);
  }

  it.each(CASES.map((c) => [c.slug, c] as const))('%s', (_slug, c) => {
    const found = byHandle.get(probeHandle(c)) ?? [];
    if (c.admin === 'imports') {
      expect(found).toEqual([]);
      return;
    }
    expect(found.length).toBeGreaterThan(0);
    const blocksFile = found.some((i) => FILE_BLOCKING_ISSUE_TYPES.has(i.issueType));
    expect(blocksFile).toBe(c.admin === 'refuses-file');
    if (c.says) expect(found.some((i) => i.message.includes(c.says!))).toBe(true);
  });
});
