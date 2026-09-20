/**
 * The "Reportar fallo en GitHub" flow, as pure functions: the report is a
 * GitHub-shaped markdown body built from the app version, the platform and
 * the tail of app.log. It is written to the CLIPBOARD first (always, and
 * complete), then GitHub is opened with the title and — when the URL stays
 * under GitHub's limits — the body pre-filled too; otherwise the user just
 * pastes (Ctrl+V) into the box GitHub left them in.
 *
 * Nothing here touches Electron or the filesystem: the caller reads the log
 * and puts the clipboard text where it belongs.
 */

const ISSUES_URL = 'https://github.com/juanjoGonDev/devbar/issues/new';

/** GitHub's new-issue form degrades past a few KB of query string; keep a
 *  generous margin. */
export const MAX_URL_CHARS = 6500;

/** Windows' shell.openExternal refuses URLs over 2081 characters outright:
 *  a pre-filled form between both limits would fail to OPEN instead of
 *  falling back to the clipboard. Stay under with margin. */
export const MAX_URL_CHARS_WINDOWS = 2000;

/** The URL budget for a platform. Windows is capped near its own hard
 *  limit; the other desktops tolerate the generous form limit. */
export function maxUrlCharsFor(platform: string): number {
  return platform === 'win32' ? MAX_URL_CHARS_WINDOWS : MAX_URL_CHARS;
}

/** How much of app.log rides IN the URL. */
export const URL_TAIL_LINES = 60;
export const URL_TAIL_CHARS = 3000;
/** How much of app.log rides on the clipboard (always, even when the URL
 *  cannot carry the body). */
export const CLIPBOARD_TAIL_LINES = 400;
export const CLIPBOARD_TAIL_CHARS = 12_000;

interface IssueContext {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  node: string;
  osRelease: string;
}

export function issueTitle(ctx: IssueContext): string {
  return `Reporte de fallo — DevBar ${ctx.version} (${ctx.platform}-${ctx.arch})`;
}

/**
 * The most recent end of the log: the last `maxLines` lines, capped at
 * `maxChars` again from the end (a single enormous line must not eat the
 * budget). Empty or missing logs simply leave the section out.
 */
export function keepTail(
  log: string | null | undefined,
  maxLines: number,
  maxChars: number,
): string {
  if (!log) return '';
  const lines = log.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '')
    lines.pop();
  let tail = lines.slice(-maxLines).join('\n');
  if (tail.length > maxChars) {
    tail = tail.slice(-maxChars);
    // A char-budget cut that lands between the two halves of a surrogate
    // pair (an emoji at the boundary) leaves a lone low surrogate — and
    // encodeURIComponent refuses to encode one, killing the whole report.
    // Drop the orphaned half.
    const head = tail.codePointAt(0) ?? 0;
    if (head >= 0xdc00 && head <= 0xdfff) tail = tail.slice(1);
  }
  return tail;
}

function environmentSection(ctx: IssueContext): string {
  return [
    '### Entorno',
    '',
    `- DevBar: ${ctx.version}`,
    `- Sistema: ${ctx.platform} ${ctx.arch} (${ctx.osRelease})`,
    `- Electron ${ctx.electron} / Node ${ctx.node}`,
  ].join('\n');
}

/** The markdown body: what the issue template would ask for, pre-answered. */
export function buildIssueBody(
  ctx: IssueContext,
  logTail?: string | null,
): string {
  const sections = [
    '### ¿Qué ha pasado?',
    '',
    '(describe el problema)',
    '',
    environmentSection(ctx),
  ];
  if (logTail && logTail.trim()) {
    // The log can itself carry ``` runs (it may quote markdown): a fixed
    // ``` fence would let the content close the block early and GitHub
    // would render the rest as Markdown. The fence must be strictly
    // longer than any backtick run in the content.
    const longestRun = logTail
      .match(/`+/g)
      ?.reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(Math.max(3, (longestRun ?? 0) + 1));
    sections.push(
      '',
      '### Log de la app (últimas líneas)',
      '',
      `${fence}text`,
      logTail,
      fence,
    );
  }
  return sections.join('\n');
}

interface PreparedIssue {
  /** Where to send the browser. */
  url: string;
  /** False when the body did not fit the URL and the user must paste it. */
  bodyIncluded: boolean;
  /** What was copied to the clipboard (full report, longer log tail). */
  clipboardText: string;
}

/**
 * Patterns a plain developer log plausibly carries. Applied ONLY at the
 * export boundary (bug report): the local app.log stays complete — it is
 * the user's own debugging record — but nothing secret rides to the
 * clipboard or into a public GitHub URL unnoticed.
 */
const REDACTIONS: [RegExp, string][] = [
  // GitHub tokens: classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained.
  [
    /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
    '[token de GitHub]',
  ],
  // AWS access key ids.
  [/AKIA[0-9A-Z]{16}/g, '[clave AWS]'],
  // JWTs: three base64url segments.
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT]'],
  // Authorization: Bearer …
  [/[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [redacted]'],
  // URLs with userinfo: https://user:password@host — the credentials go.
  [/((?:https?|ftp):\/\/)[^\s/@:]+:[^\s@]+@/g, '$1[redacted]@'],
  // key=value / key: value secrets, with optional quotes on key and/or
  // value: password=hunter2, token="x", "password":"x" (JSON). The 'auth'
  // prefix also covers Authorization headers.
  [
    /((?:^|[\s{[;,])["']?(?:api[_-]?key|apikey|auth[a-z0-9._-]{0,12}|passwd|password|secret|token[a-z0-9._-]{0,12})["']?\s*[=:]+\s*)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi,
    '$1[redacted]',
  ],
  // CLI style: --api-key VALUE — flag and value as separate words.
  [
    /(^|\s)(--(?:api[_-]?key|apikey|auth[a-z0-9._-]{0,12}|passwd|password|secret|token[a-z0-9._-]{0,12})\s+)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi,
    '$1$2[redacted]',
  ],
  // Any long hex run: hashes, digests, raw key material.
  [/\b[a-f0-9]{32,}\b/gi, '[redacted]'],
];

function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS)
    out = out.replace(pattern, replacement);
  return out;
}

export function prepareIssueReport(
  ctx: IssueContext,
  log?: string | null,
): PreparedIssue {
  // Both export sinks derive from the SAME redacted log: what lands in
  // the GitHub URL is exactly what the clipboard carries.
  const safeLog = log ? redactSecrets(log) : log;
  const clipboardTail = keepTail(
    safeLog,
    CLIPBOARD_TAIL_LINES,
    CLIPBOARD_TAIL_CHARS,
  );
  const clipboardText = buildIssueBody(ctx, clipboardTail);
  const urlTail = keepTail(safeLog, URL_TAIL_LINES, URL_TAIL_CHARS);
  const body = buildIssueBody(ctx, urlTail);
  const withBody = `${ISSUES_URL}?title=${encodeURIComponent(
    issueTitle(ctx),
  )}&body=${encodeURIComponent(body)}`;
  const bodyIncluded = withBody.length <= maxUrlCharsFor(ctx.platform);
  return {
    url: bodyIncluded
      ? withBody
      : `${ISSUES_URL}?title=${encodeURIComponent(issueTitle(ctx))}`,
    bodyIncluded,
    clipboardText,
  };
}
