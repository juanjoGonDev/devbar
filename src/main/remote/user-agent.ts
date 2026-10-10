/**
 * Short, human labels from a User-Agent: "Safari · iOS" for the device list,
 * and a default name ("iPhone") for the pairing form. Best effort by design —
 * a User-Agent is whatever the client says it is, so nothing here is ever
 * used to decide anything, only to describe.
 */

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:CriOS|Chrome)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPad\b/, 'iPadOS'],
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const NAMES: Readonly<Record<string, string>> = {
  iPadOS: 'iPad',
  iOS: 'iPhone',
  ChromeOS: 'Chromebook',
  Windows: 'PC con Windows',
  macOS: 'Mac',
  Linux: 'Equipo Linux',
};

function first(ua: string, table: readonly [RegExp, string][]): string | null {
  return table.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
}

export function clientLabel(ua: string | undefined): string {
  const agent = ua ?? '';
  const browser = first(agent, BROWSERS) ?? 'Navegador';
  const system = first(agent, SYSTEMS);
  return system ? `${browser} · ${system}` : browser;
}

export function suggestedDeviceName(ua: string | undefined): string {
  const agent = ua ?? '';
  const system = first(agent, SYSTEMS);
  if (system === 'Android')
    return /\bMobile\b/.test(agent) ? 'Móvil Android' : 'Tablet Android';
  return (system && NAMES[system]) ?? 'Mi dispositivo';
}
