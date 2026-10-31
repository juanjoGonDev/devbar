import { autoLayout, PIPELINE_TRIGGER } from '../pipeline-graph.js';
import type {
  Pipeline,
  Workflow,
  WorkflowRunRecord,
  WorkflowRunResult,
  WorkflowTrigger,
} from '../domain-types.js';
import { FIXTURE_ID_PREFIX } from './fixture-groups.js';
import { FIXTURE_SCRIPTS_GROUP_ID } from './fixture-scripts.js';

/**
 * The dev panel's fixture workflows: enough of them to page the list, with
 * every trigger (one startup, schedules, manual with and without
 * confirmation), every tray/phone visibility, some disabled, and every graph
 * shape the canvas draws — single node, chain, parallel frames with «Todos
 * OK» on and off, branches, a join, a disconnected block, a failing branch
 * that skips what follows, an empty one and a big one for zoom and the
 * minimap. Every block runs a script of the fixture scripts group
 * (fixture-scripts.ts), and every graph is laid out by `autoLayout`.
 *
 * Nothing here runs anything: the startup workflow only runs at boot, which
 * the in-memory fixture overlay never survives, and the schedules either
 * wait hours or are disabled.
 */

const T = PIPELINE_TRIGGER;

/** A block: its id, then the scripts it runs (two or more: a frame). */
type BlockSpec = [id: string, scripts: readonly string[], requireAll?: boolean];
type EdgeSpec = [from: string, to: string];

function graph(blocks: readonly BlockSpec[], edges: readonly EdgeSpec[]) {
  const pipeline: Pipeline = {
    blocks: blocks.map(([id, scripts, requireAll]) => ({
      id,
      scripts: scripts.map((scriptId) => ({
        groupId: FIXTURE_SCRIPTS_GROUP_ID,
        scriptId,
      })),
      x: 0,
      y: 0,
      requireAll: requireAll !== false,
    })),
    edges: edges.map(([from, to]) => ({ from, to })),
  };
  return autoLayout(pipeline);
}

/** trigger → one block per script, in order. */
function chain(...scripts: string[]): Pipeline {
  const ids = scripts.map((_, index) => `b${index + 1}`);
  return graph(
    scripts.map((script, index) => [ids[index] ?? '', [script]]),
    ids.map((id, index) => [index === 0 ? T : (ids[index - 1] ?? ''), id]),
  );
}

const manual = (confirm = false): WorkflowTrigger => ({
  kind: 'manual',
  confirm,
});
const every = (n: number, unit: 'minutes' | 'hours'): WorkflowTrigger => ({
  kind: 'schedule',
  schedule: { rules: [], interval: { every: n, unit } },
});
const at = (time: string, days: number[]): WorkflowTrigger => ({
  kind: 'schedule',
  schedule: { rules: [{ time, days }], interval: null },
});

interface Options {
  enabled?: boolean;
  hidden?: boolean;
}

function workflow(
  key: string,
  name: string,
  trigger: WorkflowTrigger,
  pipeline: Pipeline,
  options: Options = {},
): Workflow {
  return {
    id: `${FIXTURE_ID_PREFIX}wf-${key}`,
    name,
    enabled: options.enabled !== false,
    hidden: options.hidden === true,
    trigger,
    graph: pipeline,
  };
}

const BIG = graph(
  [
    ['deps', ['deps']],
    ['infra', ['docker', 'cache'], true],
    ['migrar', ['migrar']],
    ['semillas', ['semillas']],
    ['build', ['build']],
    ['checks', ['lint', 'tipos'], false],
    ['test', ['test']],
    ['assets', ['assets']],
    ['docs', ['docs']],
    ['empaquetar', ['empaquetar']],
    ['publicar', ['publicar']],
    ['limpiar', ['limpiar']],
    ['rapido', ['rapido']],
    ['aviso', ['aviso']],
  ],
  [
    [T, 'deps'],
    ['deps', 'infra'],
    ['infra', 'migrar'],
    ['migrar', 'semillas'],
    ['deps', 'build'],
    ['build', 'checks'],
    ['build', 'assets'],
    ['checks', 'test'],
    ['semillas', 'test'],
    ['assets', 'docs'],
    ['test', 'empaquetar'],
    ['docs', 'empaquetar'],
    ['empaquetar', 'publicar'],
    ['publicar', 'limpiar'],
    ['empaquetar', 'aviso'],
    [T, 'rapido'],
  ],
);

/** The whole fixture set, in list order. */
export function buildFixtureWorkflows(): Workflow[] {
  return [
    workflow(
      'arranque',
      'Arranque del entorno',
      { kind: 'startup' },
      graph(
        [
          ['deps', ['deps']],
          ['infra', ['docker', 'cache']],
          ['build', ['build']],
        ],
        [
          [T, 'deps'],
          ['deps', 'infra'],
          ['infra', 'build'],
        ],
      ),
    ),
    workflow(
      'nocturno',
      'Copia nocturna (laborables 03:00)',
      at('03:00', [1, 2, 3, 4, 5]),
      chain('lento-15'),
    ),
    workflow(
      'lunes',
      'Informe de los lunes',
      at('09:30', [1]),
      chain('lento-5', 'docs'),
      { hidden: true },
    ),
    workflow(
      'cada-6h',
      'Sincronizar cada 6 horas',
      every(6, 'hours'),
      chain('rapido', 'aviso'),
    ),
    workflow(
      'cada-2m',
      'Sondeo cada 2 minutos',
      every(2, 'minutes'),
      chain('rapido'),
      { enabled: false },
    ),
    workflow('simple', 'Paso único', manual(), chain('rapido')),
    workflow(
      'desplegar',
      'Desplegar a preproducción',
      manual(true),
      chain('build', 'test', 'empaquetar', 'publicar'),
    ),
    workflow(
      'oculto',
      'Oculto en la barra y el móvil',
      manual(),
      chain('tipos'),
      {
        hidden: true,
      },
    ),
    workflow(
      'cadena',
      'Cadena lineal',
      manual(),
      chain('deps', 'build', 'lint', 'test', 'docs'),
    ),
    workflow(
      'paralelo-todos',
      'Paralelo con «Todos OK»',
      manual(),
      graph(
        [
          ['frame', ['lento-5', 'falla', 'rapido']],
          ['docs', ['docs']],
        ],
        [
          [T, 'frame'],
          ['frame', 'docs'],
        ],
      ),
    ),
    workflow(
      'paralelo-tolerante',
      'Paralelo tolerante a fallos',
      manual(),
      graph(
        [
          ['frame', ['lento-5', 'falla', 'aviso'], false],
          ['docs', ['docs']],
        ],
        [
          [T, 'frame'],
          ['frame', 'docs'],
        ],
      ),
    ),
    workflow(
      'ramas',
      'Ramas C→D→E y C→F→G',
      manual(),
      graph(
        [
          ['C', ['deps']],
          ['D', ['build']],
          ['E', ['test']],
          ['F', ['assets']],
          ['G', ['docs']],
        ],
        [
          [T, 'C'],
          ['C', 'D'],
          ['D', 'E'],
          ['C', 'F'],
          ['F', 'G'],
        ],
      ),
    ),
    workflow(
      'union',
      'Unión de ramas',
      manual(),
      graph(
        [
          ['migrar', ['migrar']],
          ['assets', ['assets']],
          ['empaquetar', ['empaquetar']],
        ],
        [
          [T, 'migrar'],
          [T, 'assets'],
          ['migrar', 'empaquetar'],
          ['assets', 'empaquetar'],
        ],
      ),
    ),
    workflow(
      'desconectado',
      'Con un bloque desconectado',
      manual(),
      graph(
        [
          ['deps', ['deps']],
          ['build', ['build']],
          ['suelto', ['limpiar']],
          ['despues', ['docs']],
        ],
        [
          [T, 'deps'],
          ['deps', 'build'],
          ['suelto', 'despues'],
        ],
      ),
    ),
    workflow(
      'rama-falla',
      'Rama que falla y se salta lo demás',
      manual(),
      graph(
        [
          ['deps', ['deps']],
          ['falla', ['falla']],
          ['build', ['build']],
          ['publicar', ['publicar']],
          ['ok', ['lint']],
        ],
        [
          [T, 'deps'],
          ['deps', 'falla'],
          ['falla', 'build'],
          ['build', 'publicar'],
          ['deps', 'ok'],
        ],
      ),
    ),
    workflow('grande', 'Pipeline grande (zoom y minimapa)', manual(), BIG),
    workflow('largo', 'Proceso largo (40 s)', manual(), chain('lento-40')),
    workflow(
      'timeout',
      'Paso que excede su tiempo',
      manual(),
      chain('rapido', 'timeout'),
    ),
    workflow(
      'confirmar',
      'Paso que pide confirmación',
      manual(),
      chain('confirmar', 'lento-5'),
    ),
    workflow('ruidoso', 'Mucha salida en el log', manual(), chain('ruidoso')),
    workflow(
      'limpieza',
      'Limpieza semanal (desactivado)',
      at('18:00', [5]),
      chain('limpiar'),
      { enabled: false },
    ),
    workflow('borrador', 'Borrador desactivado', manual(), chain('semillas'), {
      enabled: false,
    }),
    workflow('vacio', 'Workflow vacío', manual(), graph([], [])),
  ];
}

const MINUTE = 60_000;

/**
 * A last run of every result for a few of the fixture workflows — the rest
 * have never run — so the list shows each status without running anything.
 */
export function buildFixtureWorkflowRuns(
  now: number,
): Record<string, WorkflowRunRecord> {
  const seeded: [key: string, result: WorkflowRunResult, agoMin: number][] = [
    ['arranque', 'success', 90],
    ['simple', 'success', 5],
    ['paralelo-tolerante', 'warning', 30],
    ['rama-falla', 'error', 60 * 26],
    ['largo', 'cancelled', 12],
    ['desplegar', 'error', 60 * 24 * 3],
  ];
  return Object.fromEntries(
    seeded.map(([key, result, agoMin], index) => {
      const finishedAt = now - agoMin * MINUTE;
      const durationMs = (index + 1) * 7_000;
      return [
        `${FIXTURE_ID_PREFIX}wf-${key}`,
        { startedAt: finishedAt - durationMs, finishedAt, durationMs, result },
      ];
    }),
  );
}
