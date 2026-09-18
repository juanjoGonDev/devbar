/**
 * ANSI escape sequences → styled HTML, and the inverse (strip them out).
 *
 * A dev server writes colour, and a log viewer that shows the raw escapes is
 * unreadable. Everything here is a pure string transform: no DOM and no state
 * carried between calls, so the whole table of SGR codes can be exercised
 * directly instead of through a rendered window.
 *
 * Every text run is HTML-escaped before it reaches a span, and the only inline
 * styles ever emitted come from the palettes below or from numbers clamped
 * into `rgb(...)` — a log line can never inject markup of its own.
 */
type AnsiStyle = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};
// ───────────────────────── ANSI parsing ──────────────────────────
const ANSI_ANY_RE = /\x1b\[[\d;?]*[a-zA-Z]/g;
const ANSI_SGR_RE = /\x1b\[([\d;?]*)([a-zA-Z])/g;

const PALETTE_FG: Record<number, string> = {
  30: '#3a3a3c',
  31: '#ff6961',
  32: '#5fdb86',
  33: '#ffd60a',
  34: '#5e9eff',
  35: '#d97cf2',
  36: '#7adfff',
  37: '#e5e5e7',
  90: '#8e8e93',
  91: '#ff8a8a',
  92: '#7eea9f',
  93: '#ffe066',
  94: '#85b6ff',
  95: '#e29bf6',
  96: '#a3e8ff',
  97: '#ffffff',
};

const PALETTE_BG: Record<number, string> = {
  40: '#3a3a3c',
  41: '#ff453a',
  42: '#30d158',
  43: '#a07a00',
  44: '#0a84ff',
  45: '#9543c1',
  46: '#0090a8',
  47: '#dcdce0',
  100: '#5e5e63',
  101: '#ff6961',
  102: '#5fdb86',
  103: '#ffe066',
  104: '#5e9eff',
  105: '#d97cf2',
  106: '#7adfff',
  107: '#f5f5f7',
};

function color256(n: number): string {
  if (n < 16) {
    const map = [
      30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97,
    ];
    const code = map[n];
    return code === undefined ? '#e5e5e7' : (PALETTE_FG[code] ?? '#e5e5e7');
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const ramp = [0, 95, 135, 175, 215, 255];
  return `rgb(${ramp[r] ?? 0},${ramp[g] ?? 0},${ramp[b] ?? 0})`;
}

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

function spanFor(text: string, style: AnsiStyle): string {
  if (!text) return '';
  const css: string[] = [];
  if (style.fg) css.push(`color:${style.fg}`);
  if (style.bg) css.push(`background:${style.bg}`);
  if (style.bold) css.push('font-weight:600');
  if (style.dim) css.push('opacity:0.65');
  if (style.italic) css.push('font-style:italic');
  if (style.underline) css.push('text-decoration:underline');
  if (!css.length) return escapeHtml(text);
  return `<span style="${css.join(';')}">${escapeHtml(text)}</span>`;
}

function clamp255(n: number | undefined): number {
  return Math.max(0, Math.min(255, (n ?? 0) | 0));
}

function applyCodes(codeStr: string, style: AnsiStyle): void {
  const codes = (codeStr || '')
    .split(';')
    .map((s) => (s === '' ? 0 : parseInt(s, 10)));
  let i = 0;
  while (i < codes.length) {
    const rawCode = codes[i];
    const c = rawCode === undefined || Number.isNaN(rawCode) ? 0 : rawCode;
    if (c === 0) {
      style.fg = null;
      style.bg = null;
      style.bold = false;
      style.dim = false;
      style.italic = false;
      style.underline = false;
    } else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 22) {
      style.bold = false;
      style.dim = false;
    } else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 39) style.fg = null;
    else if (c === 49) style.bg = null;
    else if (PALETTE_FG[c]) style.fg = PALETTE_FG[c];
    else if (PALETTE_BG[c]) style.bg = PALETTE_BG[c];
    else if (c === 38 && codes[i + 1] === 5) {
      style.fg = color256(codes[i + 2] || 0);
      i += 2;
    } else if (c === 38 && codes[i + 1] === 2) {
      style.fg = `rgb(${clamp255(codes[i + 2])},${clamp255(codes[i + 3])},${clamp255(codes[i + 4])})`;
      i += 4;
    } else if (c === 48 && codes[i + 1] === 5) {
      style.bg = color256(codes[i + 2] || 0);
      i += 2;
    } else if (c === 48 && codes[i + 1] === 2) {
      style.bg = `rgb(${clamp255(codes[i + 2])},${clamp255(codes[i + 3])},${clamp255(codes[i + 4])})`;
      i += 4;
    }
    i += 1;
  }
}

export function ansiToHtml(line: string): string {
  const cleaned = line.replace(/\r/g, '');
  const out: string[] = [];
  const style: AnsiStyle = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };
  ANSI_SGR_RE.lastIndex = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_SGR_RE.exec(cleaned)) !== null) {
    const text = cleaned.slice(lastIndex, m.index);
    if (text) out.push(spanFor(text, style));
    if (m[2] === 'm') applyCodes(m[1] ?? '', style);
    lastIndex = ANSI_SGR_RE.lastIndex;
  }
  out.push(spanFor(cleaned.slice(lastIndex), style));
  return out.join('');
}

export function stripAnsi(s: string): string {
  return (s || '').replace(ANSI_ANY_RE, '');
}
