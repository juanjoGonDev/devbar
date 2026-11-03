import { describe, expect, it } from 'vitest';
import type { McpDiffLine } from '../src/ipc-contract/mcp-api.js';
import {
  COMMAND_FIELDS,
  diffEntity,
  GROUP_FIELDS,
  scheduleText,
  workflowFields,
} from '../src/main/mcp/config-diff.js';
import { makeCommand, makeGroup } from './helpers/main-fakes.js';

describe('src/main/mcp/config-diff.ts', () => {
  it('shows the name as context and each changed line as a removal and an addition', () => {
    const before = makeCommand({
      name: 'Normal',
      command: 'pnpm dev',
      cwd: '~/back',
    });
    const after = { ...before, command: 'pnpm dev --inspect' };

    const result = diffEntity(COMMAND_FIELDS, before, after);

    expect(result.diff).toEqual<McpDiffLine[]>([
      { kind: 'ctx', field: 'nombre', text: 'Normal' },
      { kind: 'del', field: 'comando', text: 'pnpm dev' },
      { kind: 'add', field: 'comando', text: 'pnpm dev --inspect' },
      { kind: 'ctx', field: 'carpeta', text: '~/back' },
    ]);
    expect(result).toMatchObject({ changed: ['comando'], risk: 'executes' });
  });

  it('compares env entry by entry', () => {
    const before = makeCommand({
      env: [{ key: 'A', value: '1', enabled: true }],
    });
    const after = {
      ...before,
      env: [
        { key: 'A', value: '1', enabled: true },
        { key: 'B', value: '2', enabled: false },
      ],
    };

    expect(diffEntity(COMMAND_FIELDS, before, after).diff).toContainEqual({
      kind: 'add',
      field: 'entorno',
      text: 'B=2 (desactivada)',
    });
  });

  it('calls a rename or a recolour cosmetic', () => {
    const before = makeGroup();

    expect(
      diffEntity(GROUP_FIELDS, before, {
        ...before,
        name: 'Otro',
        iconColor: '#00ff00',
      }).risk,
    ).toBe('cosmetic');
  });

  it('calls a new folder executing', () => {
    const before = makeGroup();

    expect(
      diffEntity(GROUP_FIELDS, before, { ...before, path: '/elsewhere' }).risk,
    ).toBe('executes');
  });

  it('lists everything as added for a creation and removed for a deletion', () => {
    const group = makeGroup({
      name: 'Docs',
      commands: [makeCommand({ name: 'web' })],
    });

    const created = diffEntity(GROUP_FIELDS, null, group);
    const deleted = diffEntity(GROUP_FIELDS, group, null);

    expect(created.diff.every((line) => line.kind === 'add')).toBe(true);
    expect(deleted.diff.every((line) => line.kind === 'del')).toBe(true);
    expect(deleted.diff).toContainEqual({
      kind: 'del',
      field: 'comandos',
      text: 'web',
    });
    expect(deleted.risk).toBe('destructive');
  });

  it('changes nothing for identical entities', () => {
    const command = makeCommand();

    expect(diffEntity(COMMAND_FIELDS, command, { ...command }).changed).toEqual(
      [],
    );
  });

  it.each([
    [{ enabled: false, rules: [], interval: null }, 'desactivada'],
    [
      {
        enabled: true,
        rules: [{ time: '09:00', days: [1, 5] }],
        interval: null,
      },
      '09:00 días 1,5',
    ],
    [
      {
        enabled: true,
        rules: [],
        interval: {
          every: 15,
          unit: 'minutes' as const,
          window: { from: '09:00', to: '18:00' },
          days: [1],
        },
      },
      'cada 15 minutos de 09:00 a 18:00 días 1',
    ],
    [{ enabled: true, rules: [], interval: null }, 'sin reglas'],
  ])('describes the schedule %j', (schedule, text) => {
    expect(scheduleText(schedule)).toBe(text);
  });

  it('describes a workflow by its trigger, blocks and edges', () => {
    const fields = workflowFields(
      (groupId, scriptId) => `${groupId}/${scriptId}`,
    );
    const workflow = {
      id: 'w',
      name: 'Noche',
      enabled: true,
      hidden: false,
      trigger: {
        kind: 'schedule' as const,
        schedule: { rules: [{ time: '02:00', days: [] }], interval: null },
      },
      graph: {
        blocks: [
          {
            id: 'b1',
            scripts: [
              { groupId: 'g', scriptId: 'a' },
              { groupId: 'g', scriptId: 'b' },
            ],
            x: 0,
            y: 0,
            requireAll: false,
          },
        ],
        edges: [{ from: 'trigger', to: 'b1' }],
      },
    };

    expect(diffEntity(fields, null, workflow).diff).toEqual(
      expect.arrayContaining([
        { kind: 'add', field: 'disparador', text: 'programado: 02:00 días ' },
        {
          kind: 'add',
          field: 'bloque',
          text: 'b1: g/a + g/b (sin «Todos OK»)',
        },
        { kind: 'add', field: 'conexión', text: 'trigger → b1' },
      ]),
    );
  });
});
