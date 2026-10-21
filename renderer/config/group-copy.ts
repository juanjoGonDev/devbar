import type { Group } from '../../src/domain-types.js';

/**
 * What «Duplicar» saves: the group without its id or place (main assigns
 * both), named «… (copia)», starting nothing on its own — a second
 * auto-start or schedule of the same command line would run it twice.
 */
export function duplicateOf(stored: Group): Omit<Group, 'id' | 'order'> {
  const { id: _id, order: _order, ...rest } = structuredClone(stored);
  return {
    ...rest,
    name: `${stored.name} (copia)`,
    commands: rest.commands.map((c) => ({
      ...c,
      autoStart: false,
      schedule: { ...c.schedule, enabled: false },
    })),
    actions: rest.actions.map((a) => ({
      ...a,
      schedule: { ...a.schedule, enabled: false },
    })),
  };
}
