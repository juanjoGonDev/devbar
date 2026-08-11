export function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function buildSilencePattern(line: string | null | undefined): string {
  if (line == null) return '';
  const trimmed = String(line).trim();
  if (!trimmed) return '';
  return regexEscape(trimmed).replace(/\d{2,}/g, '\\d+');
}
