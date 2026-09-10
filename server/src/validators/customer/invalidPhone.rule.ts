import {
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from 'libphonenumber-js/max';
import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// Matches Excel scientific notation for large numbers, e.g. 1.23456E+11
const SCIENTIFIC_NOTATION_REGEX = /\d+\.?\d*[eE][+\-]?\d+/;

// A number without a leading "+" is read as a US/Canada number. That matches every
// verdict the test stores have returned: a 9-digit Senegalese mobile with no +221 is
// rejected, the same number written +221 is accepted.
const DEFAULT_COUNTRY = 'US';

// Shopify validates phones against libphonenumber's number ranges, not a digit count.
// Scored against 10,034 imported phones (2026-09-10), this check predicted all 685
// Shopify rejections; the old 10-15 digit count predicted none of them. What it
// catches that a count cannot: area codes nobody uses (555, 710, 987), exchanges
// starting 0 or 1 (617-161-xxxx), and 11-digit numbers that don't start with 1.
export class InvalidPhoneRule implements CustomerValidationRule {
  name = 'InvalidPhoneRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const phone = row.normalized['Phone'] ?? '';
      if (!phone) continue;

      const issue = (message: string, suggestedFix: string) =>
        issues.push({
          rowNumber: row.rowNumber,
          column: 'Phone',
          severity: 'Error',
          issueType: 'InvalidPhone',
          currentValue: row.original['Phone'] ?? '',
          message,
          suggestedFix,
        });

      if (SCIENTIFIC_NOTATION_REGEX.test(phone)) {
        issue(
          `Phone number "${phone}" appears to be in Excel scientific notation. The original digits were lost.`,
          'Re-export the CSV with the phone column formatted as Text to preserve all digits.',
        );
        continue;
      }

      // A leading apostrophe is Excel's "store as text" marker. Shopify ignores it
      // (an apostrophe-prefixed 11-digit NANP number imported fine), so it must not
      // decide the verdict here.
      const candidate = phone.replace(/^'+/, '');

      // libphonenumber accepts "613-555-0104 ext 12" as a valid number with an
      // extension; Shopify rejected exactly that in the 2026-09-10 probe.
      if (parsePhoneNumberFromString(candidate, DEFAULT_COUNTRY)?.ext) {
        issue(
          `Phone number "${phone}" includes an extension. Shopify rejects phone numbers with extensions.`,
          'Remove the extension (keep it in the Note if it matters), or leave the field blank.',
        );
        continue;
      }
      if (isValidPhoneNumber(candidate, DEFAULT_COUNTRY)) continue;

      switch (validatePhoneNumberLength(candidate, DEFAULT_COUNTRY)) {
        case 'NOT_A_NUMBER':
          issue(
            `Phone "${phone}" is not a phone number.`,
            "Replace it with the customer's real number, or leave the field blank.",
          );
          break;
        case 'TOO_SHORT':
          issue(
            `Phone number "${phone}" is too short. Shopify rejects local numbers without an area code.`,
            'Add the area code (and a + country code if outside the US/Canada), or leave the field blank.',
          );
          break;
        case 'TOO_LONG':
        case 'INVALID_LENGTH':
          issue(
            `Phone number "${phone}" has the wrong number of digits. Without a leading "+", it is read as a US/Canada number.`,
            'If it is an international number, add a leading + and its country code; otherwise correct the digits or leave the field blank.',
          );
          break;
        case 'INVALID_COUNTRY':
          issue(
            `Phone number "${phone}" starts with a country code that does not exist.`,
            'Correct the + country code, or leave the field blank.',
          );
          break;
        default:
          issue(
            `Phone number "${phone}" is not a valid number: that area code or prefix is not in service. Without a leading "+", it is read as a US/Canada number.`,
            'Check the number. An international number needs a leading + and its country code; otherwise leave the field blank.',
          );
      }
    }

    return issues;
  }
}
