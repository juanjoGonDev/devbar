import type {
  Command,
  GlobalSettings,
  Group,
  ProcessState,
} from '../domain-types.js';
import type { TrayColor } from '../tray-icon.js';

/**
 * The tray colour one process contributes. A stopped process is `error` only
 * when its last run left an error behind; a running one reports its worst
 * unmuted level, where muting can come from the global settings, the group,
 * or the command itself.
 */
export function deriveColor(
  state: Pick<
    ProcessState,
    'status' | 'lastError' | 'errorCount' | 'warnCount'
  >,
  command: Partial<Command> | null | undefined,
  group: Partial<Group> | null | undefined,
  globals: Partial<GlobalSettings> | null | undefined,
): TrayColor {
  if (state.status !== 'running') return state.lastError ? 'error' : 'stopped';
  const muteError = Boolean(
      globals?.silenceErrors || group?.silenceErrors || command?.silenceErrors,
    ),
    muteWarn = Boolean(
      globals?.silenceWarnings ||
      group?.silenceWarnings ||
      command?.silenceWarnings,
    );
  if (state.errorCount > 0 && !muteError) return 'error';
  if (state.warnCount > 0 && !muteWarn) return 'warn';
  return 'running';
}
