import {
  DEFAULT_ERROR_REGEX,
  DEFAULT_WARN_REGEX,
} from '../../src/log-level-defaults.js';
import { shortSchedule } from '../../src/schedule-plan.js';
import { linkSummary } from './sheet-link.js';
import type { SheetKind, SheetSections } from './sheet-sections.js';
import type { SubFormData } from './sub-dialog-save.js';

/**
 * The one-line summaries the side sheet shows in each section's badge, so a
 * collapsed section still says what it holds.
 */

function envSummary(count: number): string {
  return count === 0 ? 'ninguna' : String(count);
}

function argsSummary(count: number): string {
  return count === 0 ? 'ninguno' : String(count);
}

interface ExecSummaryInput {
  isPreScript: boolean;
  timeoutSecs: number | null;
  confirm: boolean;
  confirmSecs: number | null;
}

/** «confirmación · 60 s», «límite 30 s», «sin límite» … */
function execSummary(input: ExecSummaryInput): string {
  const parts: string[] = [];
  if (input.confirm) {
    parts.push('confirmación');
    if (input.confirmSecs) parts.push(`${input.confirmSecs} s`);
  }
  if (input.isPreScript && input.timeoutSecs)
    parts.push(`límite ${input.timeoutSecs} s`);
  if (parts.length) return parts.join(' · ');
  return input.isPreScript ? 'sin límite' : 'sin confirmación';
}

interface LogsSummaryInput {
  cwd: string;
  customPatterns: boolean;
  silenced: boolean;
  maxLogLines: number | null;
}

/** What a command changes from the defaults, or «por defecto». */
function logsSummary(input: LogsSummaryInput): string {
  const parts: string[] = [];
  if (input.cwd) parts.push('otra carpeta');
  if (input.customPatterns) parts.push('regex propias');
  if (input.silenced) parts.push('silenciado');
  if (input.maxLogLines) parts.push(`${input.maxLogLines} líneas`);
  return parts.length ? parts.join(' · ') : 'por defecto';
}

/** Writes every section's badge from what the sheet's fields hold now. */
export function paintSummaries(
  sections: SheetSections,
  kind: SheetKind,
  data: SubFormData,
): void {
  sections.setBadge('env', envSummary(data.env.length));
  sections.setBadge('args', argsSummary(data.args.length));
  sections.setBadge('link', linkSummary(data.link.mode));
  sections.setBadge(
    'exec',
    execSummary({
      isPreScript: kind === 'prescript',
      timeoutSecs: data.timeoutSecs,
      confirm: data.confirm,
      confirmSecs: data.confirmSecs,
    }),
  );
  sections.setBadge(
    'schedule',
    data.schedule.enabled ? shortSchedule(data.schedule) : 'desactivada',
  );
  sections.setBadge(
    'logs',
    logsSummary({
      cwd: data.cwd,
      customPatterns:
        (data.warnRegex !== '' && data.warnRegex !== DEFAULT_WARN_REGEX) ||
        (data.errorRegex !== '' && data.errorRegex !== DEFAULT_ERROR_REGEX),
      silenced: data.silenceWarnings || data.silenceErrors,
      maxLogLines: data.maxLogLines,
    }),
  );
}
