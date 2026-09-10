import { describe, expect, it } from 'vitest';
import { runCustomerValidation } from '../src/services/customerValidation.service';
import { makeRows } from './helpers';

const types = (issues: { rowNumber: number; issueType: string }[]) =>
  issues.map((i) => `${i.rowNumber}:${i.issueType}`).sort();

// The pre-check judges the rows as the import sends them (the template dataset),
// not the raw file. Only the dedupe/tag options make the two differ.
describe('runCustomerValidation judges what is sent', () => {
  // Two customers share a phone Shopify rejects (a 9-digit number with no +).
  const rows = () =>
    makeRows([
      { 'First Name': 'Ann', Email: 'ann@example.com', Phone: '771234567', Tags: 'a' },
      { 'First Name': 'Ben', Phone: '771234567' },
    ]);

  it('with the options off, flags both invalid phones and the repeat', () => {
    expect(types(runCustomerValidation(rows(), {}))).toEqual(['2:InvalidPhone', '3:DuplicatePhone', '3:InvalidPhone']);
  });

  // The real case behind this: rows accepted by Shopify only because their phone
  // was moved to Note and never sent, yet the raw-file pre-check flagged them.
  it('with move-duplicates-to-Notes on, flags only the phone that is still sent', () => {
    expect(types(runCustomerValidation(rows(), {}, { moveDuplicatesToNotes: true }))).toEqual(['2:InvalidPhone']);
  });

  it('catches a Note pushed past Shopify\'s limit by the moved duplicate', () => {
    const issues = runCustomerValidation(
      makeRows([
        { 'First Name': 'Ann', Email: 'dup@example.com', Tags: 'a' },
        { 'First Name': 'Ben', Email: 'dup@example.com', Note: 'x'.repeat(4990) },
      ]),
      {},
      { moveDuplicatesToNotes: true },
    );
    expect(types(issues)).toEqual(['3:FieldTooLong']);
  });

  it('counts the HeliosMigrated tag toward the 250-tag limit when it is added', () => {
    const tags = Array.from({ length: 250 }, (_, i) => `t${i}`).join(',');
    expect(runCustomerValidation(makeRows([{ 'First Name': 'A', Tags: tags }]), {})).toHaveLength(0);
    expect(types(runCustomerValidation(makeRows([{ 'First Name': 'A', Tags: tags }]), {}, { heliosMigratedTag: true })))
      .toEqual(['2:TooManyTags']);
  });
});
