import { describe, it, expect } from 'vitest';
import {
  serializeConfig,
  summarizeImport,
  validateImportedConfig,
  type ImportValidation,
} from '../src/config-io.js';
import {
  importedAutoRun,
  importedGraph,
} from './helpers/imported-workflows.js';

/**
 * `src/config-io.ts` — importing a backup that carries the pipeline as a
 * graph (`pipeline`), the shape every export writes now. The pre-graph shape
 * (top-level ordered `preSteps`) is covered in config-io-prescripts.test.ts.
 */

function expectValid(
  result: ImportValidation,
): asserts result is Extract<ImportValidation, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
}

function expectInvalid(
  result: ImportValidation,
): asserts result is Extract<ImportValidation, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected invalid import');
}

const script = (id: string) => ({ id, name: id, command: `make ${id}` });

const base = {
  version: 4,
  groups: [
    {
      id: 'g1',
      name: 'My Group',
      path: '/some/path',
      mode: 'multi',
      commands: [],
      actions: [],
      preScripts: [script('sc-bbb'), script('sc-ccc')],
    },
    {
      id: 'g2',
      name: 'Other Group',
      path: '/other/path',
      mode: 'multi',
      commands: [],
      actions: [],
      preScripts: [script('sc-eee')],
    },
  ],
  globalSettings: {},
};

const LEGACY_STEPS = [
  {
    id: 'step-aaa',
    mode: 'parallel',
    scripts: [{ groupId: 'g1', scriptId: 'sc-bbb' }],
  },
];

describe('validateImportedConfig — `pipeline` graph import', () => {
  const GRAPH = {
    blocks: [
      {
        id: 'b1',
        scripts: [
          { groupId: 'g1', scriptId: 'sc-bbb' },
          { groupId: 'g1', scriptId: 'sc-ccc' },
        ],
        x: 320,
        y: 40,
        requireAll: true,
      },
      {
        id: 'b2',
        scripts: [{ groupId: 'g2', scriptId: 'sc-eee' }],
        x: 0,
        y: 0,
        requireAll: false,
      },
    ],
    edges: [{ from: 'trigger', to: 'b1' }],
  };

  it('imports the graph exactly, disconnected blocks included', () => {
    const result = validateImportedConfig({ ...base, pipeline: GRAPH });
    expectValid(result);
    expect(importedGraph(result.payload)).toEqual(GRAPH);
  });

  it('prefers `pipeline` over a stray `preSteps`', () => {
    const result = validateImportedConfig({
      ...base,
      preSteps: LEGACY_STEPS,
      pipeline: GRAPH,
    });
    expectValid(result);
    expect(importedGraph(result.payload)).toEqual(GRAPH);
  });

  it('rejects a graph with a cycle', () => {
    const result = validateImportedConfig({
      ...base,
      pipeline: {
        ...GRAPH,
        edges: [
          { from: 'trigger', to: 'b1' },
          { from: 'b1', to: 'b2' },
          { from: 'b2', to: 'b1' },
        ],
      },
    });
    expectInvalid(result);
    expect(result.error).toBe('El pipeline tiene un ciclo');
  });

  it('rejects a block referencing a script the payload does not define', () => {
    const result = validateImportedConfig({
      ...base,
      pipeline: {
        blocks: [{ id: 'b1', scripts: [{ groupId: 'g1', scriptId: 'ghost' }] }],
        edges: [],
      },
    });
    expectInvalid(result);
    expect(result.error).toBe(
      'Un bloque referencia un grupo o script inexistente',
    );
  });
});

describe('validateImportedConfig — `workflows` import', () => {
  const workflow = (id: string, trigger: unknown, scriptId = 'sc-bbb') => ({
    id,
    name: `Flujo ${id}`,
    enabled: true,
    showInTray: true,
    showInRemote: true,
    trigger,
    graph: {
      blocks: [
        {
          id: 'b1',
          scripts: [{ groupId: 'g1', scriptId }],
          x: 0,
          y: 0,
          requireAll: true,
        },
      ],
      edges: [{ from: 'trigger', to: 'b1' }],
    },
  });
  const MANUAL = { kind: 'manual', confirm: true };

  it('imports every workflow exactly, ignoring any legacy pipeline', () => {
    const workflows = [
      workflow('a', { kind: 'startup' }),
      workflow('b', MANUAL),
    ];
    const result = validateImportedConfig({
      ...base,
      workflows,
      pipeline: { blocks: [], edges: [] },
    });
    expectValid(result);
    expect(result.payload.workflows).toEqual(workflows);
  });

  it("moves a legacy manual trigger's flags onto the workflow", () => {
    const {
      showInTray: _tray,
      showInRemote: _remote,
      ...legacy
    } = workflow('b', { ...MANUAL, showInTray: false, showInRemote: true });
    const result = validateImportedConfig({ ...base, workflows: [legacy] });
    expectValid(result);
    expect(result.payload.workflows?.[0]).toMatchObject({
      showInTray: false,
      showInRemote: true,
      trigger: MANUAL,
    });
  });

  it('rejects a second startup workflow', () => {
    const result = validateImportedConfig({
      ...base,
      workflows: [
        workflow('a', { kind: 'startup' }),
        workflow('b', { kind: 'startup' }),
      ],
    });
    expectInvalid(result);
    expect(result.error).toBe('Workflow #1: Ya hay un workflow de arranque');
  });

  it('rejects two workflows sharing an id', () => {
    const result = validateImportedConfig({
      ...base,
      workflows: [workflow('a', MANUAL), workflow('a', MANUAL)],
    });
    expectInvalid(result);
    expect(result.error).toBe('Workflow #1 repite el id de otro');
  });

  it('rejects a workflow referencing a script the payload does not define', () => {
    const result = validateImportedConfig({
      ...base,
      workflows: [workflow('a', MANUAL, 'ghost')],
    });
    expectInvalid(result);
    expect(result.error).toBe(
      'Workflow #0: Un bloque referencia un grupo o script inexistente',
    );
  });

  it('counts the workflows in the preview', () => {
    expect(
      summarizeImport({
        ...base,
        workflows: [workflow('a', MANUAL), workflow('b', MANUAL)],
      }).workflowsCount,
    ).toBe(2);
  });
});

describe('serializeConfig -> validateImportedConfig round-trip', () => {
  it('a live store with a real global pipeline exports and re-imports losslessly', () => {
    const rawStore = {
      version: 4,
      groups: [
        {
          id: 'g1',
          name: 'My Group',
          icon: '📦',
          iconColor: null,
          path: '/some/path',
          mode: 'multi' as const,
          order: 0,
          silenceWarnings: false,
          silenceErrors: false,
          env: [],
          commands: [],
          actions: [],
          waitForPipeline: true,
          hiddenInTray: false,
          preScripts: [
            {
              id: 'sc-bbb',
              name: 'Install',
              command: 'pnpm install',
              args: [],
              env: [],
              inheritGroupEnv: false,
              confirm: false,
              confirmSecs: null,
              confirmOnTimeout: 'cancel' as const,
              timeoutMs: null,
            },
          ],
        },
      ],
      // Store-shaped input is already normalized (as `getGroupsInternal()`
      // would read it) — exercising the actual export/import ROUND TRIP,
      // not `normalizeGroup`'s own default-filling (already covered
      // elsewhere).
      workflows: [
        {
          id: 'w-start',
          name: 'Arranque',
          enabled: true,
          showInTray: true,
          showInRemote: true,
          trigger: { kind: 'startup' as const },
          graph: {
            blocks: [
              {
                id: 'step-aaa',
                scripts: [{ groupId: 'g1', scriptId: 'sc-bbb' }],
                x: 320,
                y: 40,
                requireAll: false,
              },
            ],
            edges: [{ from: 'trigger', to: 'step-aaa' }],
          },
        },
      ],
      globalSettings: {
        autostart: false,
        silenceWarnings: false,
        silenceErrors: false,
      },
    };
    const exported = serializeConfig(rawStore, '0.8.0');
    const result = validateImportedConfig(exported);
    expectValid(result);
    // Asserted against literals, NOT against `exported`: comparing the
    // import result to its own export output passes vacuously the moment
    // both sides degenerate to [] (exactly the data-loss shape of C1).
    expect(importedGraph(result.payload)).toEqual({
      blocks: [
        {
          id: 'step-aaa',
          scripts: [{ groupId: 'g1', scriptId: 'sc-bbb' }],
          x: 320,
          y: 40,
          requireAll: false,
        },
      ],
      edges: [{ from: 'trigger', to: 'step-aaa' }],
    });
    expect(result.payload.groups[0]?.preScripts).toHaveLength(1);
    expect(result.payload.groups[0]?.preScripts[0]).toMatchObject({
      id: 'sc-bbb',
      name: 'Install',
      command: 'pnpm install',
    });
    expect(importedAutoRun(result.payload)).toBe(true);
  });
});
