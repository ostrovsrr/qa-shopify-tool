export function normalizeRecord(record: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[key] = value?.trim() ?? '';
  }
  return normalized;
}

export function isRowFullyEmpty(record: Record<string, string>): boolean {
  return Object.values(record).every((v) => !v || !v.trim());
}

/**
 * Reduce a phone number to a canonical digit string for comparison.
 * Strips all non-digit characters, then — for North American (NANP) numbers —
 * drops a leading "1" country code so an 11-digit number and its 10-digit form
 * are treated as the same number (e.g. "+12898851714" === "2898851714").
 */
export function canonicalPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}
