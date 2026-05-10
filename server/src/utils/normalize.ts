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
