/**
 * The "Reportar fallo en GitHub" flow, as pure functions: the report is a
 * GitHub-shaped markdown body built from the app version, the platform and
 * the tail of app.log. It is written to the CLIPBOARD first (always, and
 * complete), then GitHub is opened with the title and as much of the body
 * as its URL limit takes — the log excerpt is TRIMMED to fit, never
 * dropped for being too long. Only when not even the log-less body fits
 * does the form open bare and the user paste (Ctrl+V) into the box GitHub
 * left them in.
 *
 * Nothing here touches Electron or the filesystem: the caller reads the log
 * and puts the clipboard text where it belongs.
 */

const ISSUES_URL = 'https://github.com/juanjoGonDev/devbar/issues/new';

/**
 * The ceiling is GITHUB'S, not the browser's: the new-issue endpoint sits
 * behind a classic ~8 KB request-line limit and answers an error page long
 * before any desktop browser would complain. Measured with curl against
 * https://github.com/juanjoGonDev/devbar/issues/new:
 *
 *     ~6 070 chars   → 302 (the form opens)
 *     ~7 070-7 570   → 500
 *     ~8 270 and up  → 414 URI Too Large
 *
 * 6500 is therefore the honest budget, with margin inside the range that
 * still works. Raising it per browser cannot help: what refuses the
 * request is the server, so a bigger URL only buys the user an error page
 * where the form should have been.
 */
export const MAX_URL_CHARS = 6500;

/** Windows' shell.openExternal refuses URLs over 2081 characters outright:
 *  a pre-filled form between both limits would fail to OPEN instead of
 *  falling back to the clipboard. Stay under with margin. */
export const MAX_URL_CHARS_WINDOWS = 2000;

/** The URL budget for a platform: Windows is capped near its own launch
 *  limit, everywhere else GitHub's ceiling is what binds. */
export function maxUrlCharsFor(platform: string): number {
  return platform === 'win32' ? MAX_URL_CHARS_WINDOWS : MAX_URL_CHARS;
}

/** How much of app.log rides on the clipboard (always, and complete). The
 *  URL carries the longest END of this same tail that its budget allows. */
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

/** No line cap: `keepTail` is being asked for a character budget only. */
const NO_LINE_LIMIT = Number.MAX_SAFE_INTEGER;

/** The form with the title alone: what is left when no body fits. */
function issueUrl(ctx: IssueContext): string {
  return `${ISSUES_URL}?title=${encodeURIComponent(issueTitle(ctx))}`;
}

function issueUrlWithBody(ctx: IssueContext, logTail: string): string {
  return `${issueUrl(ctx)}&body=${encodeURIComponent(
    buildIssueBody(ctx, logTail),
  )}`;
}

/** How much of a fitted excerpt may be spent to start it on a whole line. */
const LINE_BOUNDARY_COST = 0.1;

/**
 * Keep the excerpt from opening mid-line: a log that starts on half a
 * timestamp reads like a corrupted paste. Only when the first newline is
 * NEAR the cut — dropping a long first line would cost more log than the
 * tidiness is worth — and never when the cut already landed on a boundary.
 */
function openOnLineBoundary(full: string, kept: string): string {
  if (kept.length >= full.length) return kept;
  if (full[full.length - kept.length - 1] === '\n') return kept;
  const newline = kept.indexOf('\n');
  if (newline === -1) return kept;
  const whole = kept.slice(newline + 1);
  return whole.length >= kept.length * (1 - LINE_BOUNDARY_COST) ? whole : kept;
}

/**
 * The longest END of `tail` whose ENCODED url stays inside `budget`.
 * Encoding is what overflows, never the raw size: a space triples (%20)
 * and an accent multiplies by six to nine, so 3000 plain characters can
 * encode past 6000 — which is why a fixed character slice either wasted
 * most of the budget or blew it, and the whole body was dropped. A halving
 * search over the kept length instead: bounded by construction (the
 * interval strictly shrinks, so ~log2(tail.length) probes), and every cut
 * goes through `keepTail`, which is what keeps one from orphaning half a
 * surrogate pair. Answers '' when not even a fragment fits — the body then
 * rides with the environment alone.
 *
 * The caller must have checked that the log-less body fits.
 */
function fitTailToBudget(
  ctx: IssueContext,
  tail: string,
  budget: number,
): string {
  if (issueUrlWithBody(ctx, tail).length <= budget) return tail;
  let fits = 0;
  let over = tail.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    const candidate = keepTail(tail, NO_LINE_LIMIT, middle);
    if (issueUrlWithBody(ctx, candidate).length <= budget) fits = middle;
    else over = middle;
  }
  return fits === 0
    ? ''
    : openOnLineBoundary(tail, keepTail(tail, NO_LINE_LIMIT, fits));
}

interface PreparedIssue {
  /** Where to send the browser. */
  url: string;
  /** False only when not even the log-less body fit the URL: the form
   *  opens with the title alone and the user pastes the rest. True may
   *  still carry a SHORTENED excerpt — the clipboard has it whole. */
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
  // PEM private keys: the body is the key itself, so the whole block goes.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[clave privada]',
  ],
  // A DECAPITATED key: the report reads the last 64 KiB of app.log and
  // drops the torn first line, which is exactly the BEGIN the rule above
  // needs — leaving the base64 body, which escapes every other rule here
  // (mixed case, with + / =). Applied after the paired rule, so any END
  // still standing proves its key is above it: everything up to it goes.
  [/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, '[clave privada]'],
  // Vendor tokens that carry their own prefix and need no key name beside
  // them: Slack, npm, Google, Stripe.
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[token de Slack]'],
  [/\bnpm_[A-Za-z0-9]{20,}/g, '[token de npm]'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, '[clave de Google]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, '[clave de Stripe]'],
  // URLs with userinfo: ANY scheme, not just the web ones — a service log's
  // most likely secret is a connection string (postgres://, mysql://,
  // redis://, mongodb+srv://, amqp://) carrying its own password.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s@]+@/gi, '$1[redacted]@'],
  // key=value / key: value secrets, with optional quotes on key and/or
  // value: password=hunter2, token="x", "password":"x" (JSON), URL query
  // parameters (?token=x, &api_key=x — the ';' delimiter also covers
  // HTML-escaped &amp;) and CLI assignment (--api-key=x). The 'auth'
  // prefix also covers Authorization headers. An Authorization scheme
  // (Basic/Bearer) is consumed WITH its credential — stopping at the
  // space would redact the scheme and leave the credential behind.
  [
    /((?:^|[\s{[;,?&])["']?(?:--)?[a-z0-9._-]{0,24}(?:api[_-]?key|apikey|auth|passwd|password|secret|token)[a-z0-9._-]{0,12}["']?\s*[=:]+\s*)(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi,
    '$1[redacted]',
  ],
  // CLI style: --api-key VALUE — flag and value as separate words.
  [
    /(^|\s)(--[a-z0-9._-]{0,24}(?:api[_-]?key|apikey|auth|passwd|password|secret|token)[a-z0-9._-]{0,12}\s+)(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi,
    '$1$2[redacted]',
  ],
  // Bare `key value`, the shape of a credentials file or CLI output
  // (`aws_secret_access_key wJalr…`). The value must LOOK like key
  // material — at least 20 characters of key alphabet — because a plain
  // "key word" rule would turn "token expired" into "token [redacted]"
  // and strip the log of the words that explain the failure.
  [
    /((?:^|\s)[a-z0-9._-]{0,24}(?:api[_-]?key|apikey|passwd|password|secret|token)[a-z0-9._-]{0,12}\s+)([A-Za-z0-9+/=_-]{20,})/gi,
    '$1[redacted]',
  ],
  // Any long hex run: hashes, digests, raw key material.
  [/\b[a-f0-9]{32,}\b/gi, '[redacted]'],
  // Absolute home paths (the logger opens with one): the username and the
  // filesystem layout need not travel with the report. The whitespace
  // boundary keeps URL PATHS like example.com/home/public intact.
  [/(^|\s)(\/(?:home|Users)\/[^\s/]+)/g, '$1~'],
  [/(^|\s)([A-Za-z]:\\Users\\[^\s\\]+)/g, '$1~'],
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
  // Both export sinks derive from the SAME redacted log — redaction runs
  // BEFORE any truncation, so no cut can split a secret open — and what
  // rides in the URL is an END of exactly what the clipboard carries.
  const safeLog = log ? redactSecrets(log) : log;
  const clipboardTail = keepTail(
    safeLog,
    CLIPBOARD_TAIL_LINES,
    CLIPBOARD_TAIL_CHARS,
  );
  const clipboardText = buildIssueBody(ctx, clipboardTail);
  const budget = maxUrlCharsFor(ctx.platform);
  // Nothing to shorten towards: even the environment overflows the URL.
  if (issueUrlWithBody(ctx, '').length > budget)
    return { url: issueUrl(ctx), bodyIncluded: false, clipboardText };
  return {
    url: issueUrlWithBody(ctx, fitTailToBudget(ctx, clipboardTail, budget)),
    bodyIncluded: true,
    clipboardText,
  };
}
