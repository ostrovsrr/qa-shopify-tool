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

  it('with move-invalid-to-Notes on, stops flagging the values it strips', () => {
    const bad = () =>
      makeRows([{ 'First Name': 'Ann', Email: 'qa..probe@example.com', Phone: '555-555-5555' }]);
    expect(types(runCustomerValidation(bad(), {}))).toEqual(['2:InvalidEmail', '2:InvalidPhone']);
    expect(runCustomerValidation(bad(), {}, { moveInvalidContactToNotes: true })).toHaveLength(0);
  });

  it('catches a Note pushed past the limit by the moved invalid value', () => {
    const issues = runCustomerValidation(
      makeRows([{ 'First Name': 'Ann', Email: 'qa..probe@example.com', Note: 'x'.repeat(4990) }]),
      {},
      { moveInvalidContactToNotes: true },
    );
    expect(types(issues)).toEqual(['2:FieldTooLong']);
  });

  it('with fill-missing-name on, stops flagging MissingContact on a row with data', () => {
    const noIdentity = () => makeRows([{ 'Default Address City': 'Toronto', Tags: 'vip' }]);
    expect(types(runCustomerValidation(noIdentity(), {}))).toEqual(['2:MissingContact']);
    expect(runCustomerValidation(noIdentity(), {}, { fillMissingContactName: true })).toHaveLength(0);
  });

  // The wrong-mapping alarm has to keep ringing: a blank row is never named, so
  // it still reports MissingContact with the option on.
  it('still reports MissingContact for a blank row with fill-missing-name on', () => {
    const blank = () => makeRows([{ 'First Name': '', Email: '', 'Default Address City': '' }]);
    expect(types(runCustomerValidation(blank(), {}, { fillMissingContactName: true })))
      .toEqual(['2:MissingContact']);
  });

  // The composition: strip the unusable email, then rescue the row it emptied.
  it('imports a row whose only identity was an invalid email when both are on', () => {
    const row = () => makeRows([{ Email: 'qa..probe@example.com', 'Default Address City': 'Toronto' }]);
    expect(types(runCustomerValidation(row(), {}))).toEqual(['2:InvalidEmail']);
    expect(types(runCustomerValidation(row(), {}, { moveInvalidContactToNotes: true })))
      .toEqual(['2:MissingContact']);
    expect(
      runCustomerValidation(row(), {}, {
        moveInvalidContactToNotes: true,
        fillMissingContactName: true,
      }),
    ).toHaveLength(0);
  });
});
