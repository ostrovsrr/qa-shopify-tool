import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

// Shaped by synthetic probes imported into a test store (2026-09-10), not by the RFC:
//   accepted: every RFC 5322 local-part character (! # $ % & ' * + / = ? ^ _ ` { | } ~ -),
//             non-ASCII letters in the local part and the domain, a one-letter TLD
//             (@example.c), a domain that does not exist, a 129-character local part
//   rejected: a leading, trailing or doubled dot in the local part, a space, no dot
//             in the domain (@example), a digit in the TLD (.n7), an underscore in
//             the domain, a local part of 130+ characters ("Email is invalid"), an
//             address over 255 characters ("Email is too long")
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~\\-\\u00C0-\\uFFFF]+";
const LOCAL = `${ATOM}(?:\\.${ATOM})*`; // no leading, trailing or doubled dot
const LABEL_CHAR = 'A-Za-z0-9\\u00C0-\\uFFFF';
const LABEL = `[${LABEL_CHAR}](?:[${LABEL_CHAR}-]{0,61}[${LABEL_CHAR}])?`;
const EMAIL_REGEX = new RegExp(`^${LOCAL}@(?:${LABEL}\\.)+[A-Za-z\\u00C0-\\uFFFF]+$`);
const MAX_LENGTH = 255;
const MAX_LOCAL_LENGTH = 129;

function problem(email: string): { message: string; fix: string } | null {
  const length = [...email].length;
  if (length > MAX_LENGTH) {
    return {
      message: `Email is ${length} characters long (Shopify's maximum is ${MAX_LENGTH}).`,
      fix: 'Correct the email address, or leave the field blank.',
    };
  }
  if (!EMAIL_REGEX.test(email)) {
    return {
      message: `"${email}" is not a valid email address.`,
      fix: 'Correct the email format, e.g. user@example.com. Check for doubled or stray dots and spaces.',
    };
  }
  const local = [...email.slice(0, email.lastIndexOf('@'))].length;
  if (local > MAX_LOCAL_LENGTH) {
    return {
      message: `The part of "${email}" before the @ is ${local} characters long; Shopify rejects more than ${MAX_LOCAL_LENGTH}.`,
      fix: 'Correct the email address, or leave the field blank.',
    };
  }
  return null;
}

export class InvalidEmailRule implements CustomerValidationRule {
  name = 'InvalidEmailRule';

  validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
    const issues: CustomerValidationIssue[] = [];

    for (const row of rows) {
      const email = row.normalized['Email'] ?? '';
      if (!email) continue;
      const found = problem(email);
      if (!found) continue;
      issues.push({
        rowNumber: row.rowNumber,
        column: 'Email',
        severity: 'Error',
        issueType: 'InvalidEmail',
        currentValue: row.original['Email'] ?? '',
        message: found.message,
        suggestedFix: found.fix,
      });
    }

    return issues;
  }
}
