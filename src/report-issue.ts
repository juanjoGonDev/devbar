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
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
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
    sections.push(
      '',
      '### Log de la app (últimas líneas)',
      '',
      '```text',
      logTail,
      '```',
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

export function prepareIssueReport(
  ctx: IssueContext,
  log?: string | null,
): PreparedIssue {
  const clipboardTail = keepTail(
    log,
    CLIPBOARD_TAIL_LINES,
    CLIPBOARD_TAIL_CHARS,
  );
  const clipboardText = buildIssueBody(ctx, clipboardTail);
  const urlTail = keepTail(log, URL_TAIL_LINES, URL_TAIL_CHARS);
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
