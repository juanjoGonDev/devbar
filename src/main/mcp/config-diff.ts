import type {
  Action,
  Command,
  EnvEntry,
  Group,
  PreScript,
  Schedule,
  Workflow,
  WorkflowTrigger,
} from '../../domain-types.js';
import type { McpDiffLine, McpRisk } from '../../ipc-contract/mcp-api.js';

/**
 * The human diff an assistant's configuration change is shown with, and how
 * risky it is. A field is rendered as Settings names it («comando»,
 * «entorno», «carpeta»…) and compared as text; list fields (env, graph) are
 * compared entry by entry. A change to anything that decides what runs —
 * the command line, env, folder, schedule, auto-start, a workflow's trigger
 * or graph — makes the change `executes`; a deletion (or an import) is
 * `destructive`; only names, icons and colours are `cosmetic`.
 */

export interface Field<T> {
  label: string;
  render(entity: T): string | string[];
  /** It decides what runs (or when): a change to it executes. */
  executes?: boolean;
  /** Shown unchanged, as context. */
  context?: boolean;
}

const yesNo = (value: boolean): string => (value ? 'sí' : 'no');

/** Controls and bidi overrides/isolates that could reorder or hide a value. */
const INVISIBLE =
  /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Spelled out (`⟨U+202E⟩`) rather than dropped: a value that carries one is
 * odd on purpose, and the user should see that before approving it.
 */
export function visible(text: string): string {
  return text.replace(
    INVISIBLE,
    (char) =>
      `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );
}

function envLines(env: readonly EnvEntry[]): string[] {
  return env.map(
    (entry) =>
      `${entry.key}=${entry.value}${entry.enabled ? '' : ' (desactivada)'}`,
  );
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ').trim();
}

export function scheduleText(schedule: {
  enabled?: boolean;
  rules: Schedule['rules'];
  interval: Schedule['interval'];
}): string {
  if (schedule.enabled === false) return 'desactivada';
  if (schedule.interval) {
    const { every, unit, window, days } = schedule.interval;
    const units = { minutes: 'minutos', hours: 'horas', days: 'días' }[unit];
    return [
      `cada ${every} ${units}`,
      window ? `de ${window.from} a ${window.to}` : '',
      days.length ? `días ${days.join(',')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return schedule.rules.length
    ? schedule.rules
        .map((rule) => `${rule.time} días ${rule.days.join(',')}`)
        .join('; ')
    : 'sin reglas';
}

function triggerText(trigger: WorkflowTrigger): string {
  if (trigger.kind === 'startup') return 'al arrancar';
  if (trigger.kind === 'manual')
    return trigger.confirm ? 'manual, con confirmación' : 'manual';
  return `programado: ${scheduleText(trigger.schedule)}`;
}

const confirmText = (target: {
  confirm: boolean;
  confirmSecs: number | null;
}): string =>
  target.confirm
    ? `sí${target.confirmSecs ? ` (${target.confirmSecs} s)` : ''}`
    : 'no';

export const GROUP_FIELDS: Field<Group>[] = [
  { label: 'nombre', render: (g) => g.name, context: true },
  { label: 'icono', render: (g) => g.icon },
  { label: 'color', render: (g) => g.iconColor ?? '' },
  { label: 'carpeta', render: (g) => g.path, executes: true, context: true },
  {
    label: 'modo',
    render: (g) => (g.mode === 'single' ? 'uno a la vez' : 'varios'),
    executes: true,
  },
  { label: 'entorno', render: (g) => envLines(g.env), executes: true },
  { label: 'oculto en la bandeja', render: (g) => yesNo(g.hiddenInTray) },
  {
    label: 'espera al workflow de arranque',
    render: (g) => yesNo(g.waitForPipeline),
    executes: true,
  },
  { label: 'comandos', render: (g) => g.commands.map((c) => c.name) },
  { label: 'acciones', render: (g) => g.actions.map((a) => a.name) },
  { label: 'pre-scripts', render: (g) => g.preScripts.map((s) => s.name) },
];

export const COMMAND_FIELDS: Field<Command>[] = [
  { label: 'nombre', render: (c) => c.name, context: true },
  { label: 'icono', render: (c) => c.icon ?? '' },
  { label: 'color', render: (c) => c.iconColor ?? '' },
  {
    label: 'comando',
    render: (c) => commandLine(c.command, c.args),
    executes: true,
  },
  {
    label: 'carpeta',
    render: (c) => c.cwd ?? '',
    executes: true,
    context: true,
  },
  { label: 'entorno', render: (c) => envLines(c.env), executes: true },
  {
    label: 'arranque automático',
    render: (c) => yesNo(c.autoStart),
    executes: true,
  },
  {
    label: 'programación',
    render: (c) => scheduleText(c.schedule),
    executes: true,
  },
  { label: 'confirmar antes', render: confirmText },
  {
    label: 'enlace',
    render: (c) => JSON.stringify(c.link ?? { mode: 'auto' }),
  },
  { label: 'patrón de avisos', render: (c) => c.warnRegex },
  { label: 'patrón de errores', render: (c) => c.errorRegex },
  {
    label: 'líneas de log',
    render: (c) => (c.maxLogLines === null ? '' : String(c.maxLogLines)),
  },
];

export const ACTION_FIELDS: Field<Action>[] = [
  { label: 'nombre', render: (a) => a.name, context: true },
  { label: 'icono', render: (a) => a.icon ?? '' },
  { label: 'color', render: (a) => a.iconColor ?? '' },
  {
    label: 'comando',
    render: (a) => commandLine(a.command, a.args),
    executes: true,
  },
  { label: 'entorno', render: (a) => envLines(a.env), executes: true },
  {
    label: 'hereda el entorno del grupo',
    render: (a) => yesNo(a.inheritGroupEnv),
    executes: true,
  },
  {
    label: 'programación',
    render: (a) => scheduleText(a.schedule),
    executes: true,
  },
  { label: 'confirmar antes', render: confirmText },
];

export const PRESCRIPT_FIELDS: Field<PreScript>[] = [
  { label: 'nombre', render: (s) => s.name, context: true },
  {
    label: 'comando',
    render: (s) => commandLine(s.command, s.args),
    executes: true,
  },
  { label: 'entorno', render: (s) => envLines(s.env), executes: true },
  {
    label: 'hereda el entorno del grupo',
    render: (s) => yesNo(s.inheritGroupEnv),
    executes: true,
  },
  {
    label: 'tiempo límite',
    render: (s) => (s.timeoutMs === null ? '' : `${s.timeoutMs} ms`),
    executes: true,
  },
  { label: 'confirmar antes', render: confirmText },
];

export function workflowFields(
  scriptName: (groupId: string, scriptId: string) => string,
): Field<Workflow>[] {
  return [
    { label: 'nombre', render: (w) => w.name, context: true },
    { label: 'activo', render: (w) => yesNo(w.enabled), executes: true },
    { label: 'oculto', render: (w) => yesNo(w.hidden) },
    {
      label: 'disparador',
      render: (w) => triggerText(w.trigger),
      executes: true,
    },
    {
      label: 'bloque',
      render: (w) =>
        w.graph.blocks.map(
          (block) =>
            `${block.id}: ${block.scripts.map((ref) => scriptName(ref.groupId, ref.scriptId)).join(' + ')}${block.scripts.length > 1 && !block.requireAll ? ' (sin «Todos OK»)' : ''}`,
        ),
      executes: true,
    },
    {
      label: 'conexión',
      render: (w) => w.graph.edges.map((edge) => `${edge.from} → ${edge.to}`),
      executes: true,
    },
  ];
}

const asList = (value: string | string[]): string[] =>
  (Array.isArray(value) ? value : [value]).filter((item) => item !== '');

export interface EntityDiff {
  diff: McpDiffLine[];
  /** Labels of the fields that changed. */
  changed: string[];
  risk: McpRisk;
}

/** `before` null is a creation, `after` null a deletion. */
export function diffEntity<T>(
  fields: readonly Field<T>[],
  before: T | null,
  after: T | null,
): EntityDiff {
  const diff: McpDiffLine[] = [];
  const changed: string[] = [];
  let executes = false;
  for (const field of fields) {
    const old = before === null ? [] : asList(field.render(before));
    const next = after === null ? [] : asList(field.render(after));
    const same =
      old.length === next.length && old.every((v, i) => v === next[i]);
    if (same) {
      if (field.context && before !== null && after !== null)
        for (const text of next)
          diff.push({ kind: 'ctx', field: field.label, text: visible(text) });
      continue;
    }
    changed.push(field.label);
    if (field.executes) executes = true;
    for (const text of old)
      if (!next.includes(text))
        diff.push({ kind: 'del', field: field.label, text: visible(text) });
    for (const text of next)
      if (!old.includes(text))
        diff.push({ kind: 'add', field: field.label, text: visible(text) });
  }
  const risk: McpRisk =
    after === null ? 'destructive' : executes ? 'executes' : 'cosmetic';
  return { diff, changed, risk };
}
