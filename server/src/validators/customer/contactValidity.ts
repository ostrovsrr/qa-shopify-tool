import {
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from 'libphonenumber-js/max';

/**
 * Is this Email / Phone value one Shopify will reject?
 *
 * The verdicts live here, apart from the rules that report them, because more
 * than one caller needs to ask the question: InvalidEmailRule / InvalidPhoneRule
 * turn a problem into an issue, and the template dataset strips the same values
 * into Note. Sharing the predicate is what stops the two drifting — the same
 * reason services/productVariants.ts is shared by the product rules and the
 * productSet builder.
 *
 * A null result means "Shopify accepts this". An empty value is not this
 * function's business: callers skip blanks (a missing contact is
 * MissingContactRule's finding).
 */
export interface ContactProblem {
  message: string;
  fix: string;
}

// ── Email ────────────────────────────────────────────────────────────────────
//
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

export function emailProblem(email: string): ContactProblem | null {
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

// ── Phone ────────────────────────────────────────────────────────────────────

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
export function phoneProblem(phone: string): ContactProblem | null {
  if (SCIENTIFIC_NOTATION_REGEX.test(phone)) {
    return {
      message: `Phone number "${phone}" appears to be in Excel scientific notation. The original digits were lost.`,
      fix: 'Re-export the CSV with the phone column formatted as Text to preserve all digits.',
    };
  }

  // A leading apostrophe is Excel's "store as text" marker. Shopify ignores it
  // (an apostrophe-prefixed 11-digit NANP number imported fine), so it must not
  // decide the verdict here.
  const candidate = phone.replace(/^'+/, '');

  // libphonenumber accepts "613-555-0104 ext 12" as a valid number with an
  // extension; Shopify rejected exactly that in the 2026-09-10 probe.
  if (parsePhoneNumberFromString(candidate, DEFAULT_COUNTRY)?.ext) {
    return {
      message: `Phone number "${phone}" includes an extension. Shopify rejects phone numbers with extensions.`,
      fix: 'Remove the extension (keep it in the Note if it matters), or leave the field blank.',
    };
  }

  if (isValidPhoneNumber(candidate, DEFAULT_COUNTRY)) return null;

  switch (validatePhoneNumberLength(candidate, DEFAULT_COUNTRY)) {
    case 'NOT_A_NUMBER':
      return {
        message: `Phone "${phone}" is not a phone number.`,
        fix: "Replace it with the customer's real number, or leave the field blank.",
      };
    case 'TOO_SHORT':
      return {
        message: `Phone number "${phone}" is too short. Shopify rejects local numbers without an area code.`,
        fix: 'Add the area code (and a + country code if outside the US/Canada), or leave the field blank.',
      };
    case 'TOO_LONG':
    case 'INVALID_LENGTH':
      return {
        message: `Phone number "${phone}" has the wrong number of digits. Without a leading "+", it is read as a US/Canada number.`,
        fix: 'If it is an international number, add a leading + and its country code; otherwise correct the digits or leave the field blank.',
      };
    case 'INVALID_COUNTRY':
      return {
        message: `Phone number "${phone}" starts with a country code that does not exist.`,
        fix: 'Correct the + country code, or leave the field blank.',
      };
    default:
      return {
        message: `Phone number "${phone}" is not a valid number: that area code or prefix is not in service. Without a leading "+", it is read as a US/Canada number.`,
        fix: 'Check the number. An international number needs a leading + and its country code; otherwise leave the field blank.',
      };
  }
}
