/**
 * Shape checks a caller runs BEFORE trusting a group: the importer rejects on
 * them, and the store uses `enforceSingleModeAutoStart` to repair an
 * invariant a normalizer cannot (it spans a group's whole command list).
 */
import { isRecord } from './raw.js';
import type { Group } from '../domain-types.js';

export function enforceSingleModeAutoStart(group: Group): {
  group: Group;
  changed: boolean;
};
export function enforceSingleModeAutoStart(group: null): {
  group: null;
  changed: boolean;
};
export function enforceSingleModeAutoStart(group: undefined): {
  group: undefined;
  changed: boolean;
};
export function enforceSingleModeAutoStart(group: Group | null | undefined): {
  group: Group | null | undefined;
  changed: boolean;
} {
  if (!group || group.mode !== 'single') return { group, changed: false };
  const flagged = group.commands.filter((command) => command.autoStart).length;
  if (flagged <= 1) return { group, changed: false };
  return {
    group: {
      ...group,
      commands: group.commands.map((command) =>
        command.autoStart ? { ...command, autoStart: false } : command,
      ),
    },
    changed: true,
  };
}

export function validateGroupShape(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isRecord(value))
    return { valid: false, errors: ['Group is null or undefined'] };
  if (typeof value.path !== 'string' || !value.path.trim())
    errors.push('Group path must not be empty');
  if (typeof value.name !== 'string' || !value.name.trim())
    errors.push('Group name must not be empty');
  if (value.mode !== 'single' && value.mode !== 'multi')
    errors.push('Group mode must be "single" or "multi"');
  if (value.preScripts !== undefined) {
    if (!Array.isArray(value.preScripts))
      errors.push('preScripts must be an array');
    else
      value.preScripts.forEach((script, scriptIndex) => {
        if (!isRecord(script)) {
          errors.push(`preScripts[${scriptIndex}] must be an object`);
          return;
        }
        if (!script.id) errors.push(`preScripts[${scriptIndex}] missing id`);
        if (!script.name)
          errors.push(`preScripts[${scriptIndex}] missing name`);
        if (script.command === undefined || script.command === null)
          errors.push(`preScripts[${scriptIndex}] missing command`);
      });
  }
  return { valid: errors.length === 0, errors };
}
