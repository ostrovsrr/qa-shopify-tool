// How Shopify's admin CSV import reads a product CSV's values. Shared by the
// pre-check rules (validators/product) and the productSet builder
// (productImport.service), so the tool judges and imports a file the way the
// real CSV import does. Every behaviour here was observed on a test store on
// 2026-09-22; see docs/products/rejection-probe-results.md. Change one only
// against a new observation.

export const MAX_TEXT_LENGTH = 255;

// A blank option value on a variant row is not an error: the admin import fills
// it in as "Default Title", the same value an option-less product's variant gets.
export const DEFAULT_OPTION_VALUE = 'Default Title';

/** A money column (Variant Price, Compare At Price, Cost per item). The admin
 *  import reads the first number in the cell and ignores the rest: "$10.00",
 *  "10 USD", "1,000.00" and "10,50" (a decimal comma) all import; "1e2" reads
 *  as 1. A cell with no digits at all refuses the WHOLE file at upload.
 *  Returns null for a blank cell, 'invalid' for a cell with no number. */
export function parseMoney(raw: string): number | null | 'invalid' {
  const v = raw.trim();
  if (v === '') return null;
  const m = /(-?)(\d[\d,]*(?:\.\d*)?|\.\d+)/.exec(v);
  if (!m) return 'invalid';
  let num = m[2];
  if (num.includes('.')) {
    num = num.replace(/,/g, ''); // "1,000.00": commas are thousands separators
  } else if (/^\d+,\d{1,2}$/.test(num)) {
    num = num.replace(',', '.'); // "10,50": a decimal comma
  } else {
    num = num.replace(/,/g, '');
  }
  const cents = roundToCents(num);
  // A number too long for a double (300-odd digits) cannot be a price; it is
  // unreadable like "abc" (see moneyIsTooLarge for the message).
  if (!Number.isFinite(cents)) return 'invalid';
  if (cents === 0) return 0;
  return ((m[1] === '-' ? -1 : 1) * cents) / 100;
}

/** "123.4567" → 12346: the amount in cents, rounded half-up on the DECIMAL
 *  digits. Rounding the double instead (Math.round(v * 100)) turned 1.005 into
 *  1.00 and 10.995 into 10.99, because neither is exactly representable; the
 *  admin import rounds half-up (10.999 → 11.00). */
function roundToCents(num: string): number {
  const [intPart, fracPart = ''] = num.split('.');
  const digits = `${intPart || '0'}${fracPart.padEnd(2, '0').slice(0, 2)}`;
  let cents = BigInt(digits);
  if ((fracPart[2] ?? '0') >= '5') cents += BigInt(1);
  return Number(cents);
}

/** An unreadable money cell that does hold a number — one too large to read —
 *  as opposed to one with no number in it at all. For the message only. */
export function moneyIsTooLarge(raw: string): boolean {
  return parseMoney(raw) === 'invalid' && /\d/.test(raw);
}

/** Format a parsed money value the way productSet's Money scalar takes it. */
export function formatMoney(value: number): string {
  return value.toFixed(2);
}

/** "Variant Grams" is read like a leading number: "100g" is 100, "1e3" is 1000,
 *  and "1,000" is 1 (the comma ends the number). No leading number is rejected
 *  as "Weight isn't a number."; a negative one as "Weight must be greater than
 *  or equal to 0". Returns null for a blank cell. */
export function parseGrams(raw: string): number | null | 'invalid' {
  const v = raw.trim();
  if (v === '') return null;
  const m = LEADING_NUMBER_RE.exec(v);
  if (!m) return 'invalid';
  // "1e999" is a leading number too large for a double. Read as Infinity it
  // passed the pre-check and the builder sent it as a null weight; it is no
  // weight at all, so it is unreadable like "heavy" (see gramsIsTooLarge).
  const value = Number(m[0]);
  return Number.isFinite(value) ? value : 'invalid';
}

const LEADING_NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;

/** An unreadable Variant Grams cell that does start with a number — one too
 *  large to read — as opposed to one with no number. For the message only. */
export function gramsIsTooLarge(raw: string): boolean {
  return parseGrams(raw) === 'invalid' && LEADING_NUMBER_RE.test(raw.trim());
}

// productSet's quantity is a GraphQL Int (32-bit signed).
export const MAX_QUANTITY = 2_147_483_647;
export const MIN_QUANTITY = -2_147_483_648;

/** "Variant Inventory Qty" never fails a product: it is read as a leading
 *  integer ("1.5" is 1, "1,000" is 1, "-3" is -3) and 0 when there is none.
 *  A quantity past what productSet's Int can carry is clamped to the limit:
 *  sent as-is it failed the whole product at the GraphQL layer, contradicting
 *  the rule above, and the clamp keeps its sign and "a lot" meaning where
 *  reading it as 0 would not. (No probe has shown what the admin import stores
 *  for such a value.) */
export function parseQuantity(raw: string): number | null {
  const v = raw.trim();
  if (v === '') return null;
  const m = /^[+-]?\d+/.exec(v);
  if (!m) return 0;
  return Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, Number(m[0])));
}

/** "Variant Inventory Policy": deny / continue in any case. Blank is 'blank'
 *  because a blank policy on a variant row refuses the whole file at upload
 *  when the column exists at all. */
export function parseInventoryPolicy(raw: string): 'DENY' | 'CONTINUE' | 'blank' | 'invalid' {
  const v = raw.trim().toLowerCase();
  if (v === '') return 'blank';
  if (v === 'deny') return 'DENY';
  if (v === 'continue') return 'CONTINUE';
  return 'invalid';
}

const STATUSES = ['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'];

/** "Status": active / draft / archived / unlisted in any case. Blank defers to
 *  the Published column. Anything else rejects the product. */
export function parseStatus(raw: string): string | null | 'invalid' {
  const v = raw.trim().toUpperCase();
  if (v === '') return null;
  return STATUSES.includes(v) ? v : 'invalid';
}

/** Image Src must be a web address; anything else is "File URL is invalid". An
 *  address that is valid but unreachable still imports (the image just fails). */
export function isValidImageUrl(raw: string): boolean {
  const v = raw.trim();
  if (/\s/.test(v)) return false;
  try {
    const url = new URL(v);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** The product's tags as the import splits them. */
export function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}
