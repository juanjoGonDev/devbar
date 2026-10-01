import path from 'node:path';
import { normalizeGroup } from '../groups-model.js';
import { quoteWindowsArg, shellQuote } from '../parse-command.js';
import type { Group } from '../domain-types.js';

/**
 * The dev panel's "Grupos de prueba": a set of groups that exercises every
 * state the tray can show — a healthy service, one that keeps raising
 * warnings and errors, one that floods its log, three ways of failing to run,
 * and actions that succeed, fail or take a while — on any machine, with or
 * without node installed.
 *
 * The long-running scripts run on the app's own binary in node mode
 * (`ELECTRON_RUN_AS_NODE=1`), so they work wherever DevBar itself runs. The
 * one-liners use the platform shell: cmd syntax on Windows, sh elsewhere.
 *
 * Every id starts with `fixture-`: the process manager keys processes by
 * group id, so a fixture can never collide with a real group's process.
 */

export const FIXTURE_ID_PREFIX = 'fixture-';
const MAX_REPEAT = 20;

export interface FixtureEnvironment {
  platform: NodeJS.Platform;
  /** The app binary — Electron, run as node by the fixtures' env. */
  execPath: string;
  tmpDir: string;
  /** A git checkout to point one group at (the repo itself in dev), if any. */
  repoPath: string | null;
}

/** `Repetir ×N`: a whole number from 1 to 20; anything else is one copy. */
export function clampFixtureRepeat(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(MAX_REPEAT, Math.max(1, Math.floor(value)));
}

const RUN_AS_NODE = [
  { key: 'ELECTRON_RUN_AS_NODE', value: '1', enabled: true },
];

// The node scripts stay clear of < > & | % ^ ! and double quotes: cmd.exe
// reinterprets those even inside a carefully quoted argument.
const SCRIPTS = {
  tick: "var n=0;setInterval(function(){n++;console.log('tick '+n+' - todo en orden')},1000)",
  alerts:
    "var n=0;setInterval(function(){n++;if(n-2*Math.floor(n/2))console.error('warning: aviso de prueba '+n);else console.error('error: fallo de prueba '+n)},1500)",
  flood:
    "var n=0;setInterval(function(){for(var i=0;i-200;i++){n++;console.log('rafaga '+n+' '+'x'.repeat(60))}},250)",
  slow: "console.log('empezando, tarda unos 5 s');setTimeout(function(){console.log('listo')},5000)",
};

function nodeCommand(env: FixtureEnvironment, script: string): string {
  const quote = env.platform === 'win32' ? quoteWindowsArg : shellQuote;
  return `${quote(env.execPath)} -e ${quote(script)}`;
}

function shell(env: FixtureEnvironment): {
  exit1: string;
  fail: string;
  join: (...parts: string[]) => string;
} {
  if (env.platform === 'win32')
    return {
      exit1: 'echo arrancando y saliendo con 1 & exit /b 1',
      fail: 'echo error: la accion de prueba falla & exit /b 1',
      join: path.win32.join,
    };
  return {
    exit1: 'echo arrancando y saliendo con 1; exit 1',
    fail: 'echo error: la accion de prueba falla >&2; exit 1',
    join: path.posix.join,
  };
}

/** One copy of the fixture set, numbered `copy` (1-based). */
function fixtureSet(env: FixtureEnvironment, copy: number): unknown[] {
  const sh = shell(env);
  const id = (key: string) => `${FIXTURE_ID_PREFIX}${copy}-${key}`;
  const name = (label: string) => `Prueba ${copy} · ${label}`;
  const node = (script: string) => nodeCommand(env, script);
  return [
    {
      id: id('services'),
      name: name('Servicios'),
      icon: 'server',
      iconColor: '#22c55e',
      path: env.tmpDir,
      mode: 'multi',
      commands: [
        {
          id: 'tick',
          name: 'Cada segundo',
          icon: 'activity',
          iconColor: '#3b82f6',
          command: node(SCRIPTS.tick),
          env: RUN_AS_NODE,
        },
        {
          id: 'alerts',
          name: 'Avisos y errores',
          icon: 'triangle-alert',
          iconColor: '#eab308',
          command: node(SCRIPTS.alerts),
          env: RUN_AS_NODE,
        },
        {
          id: 'flood',
          name: 'Mucha salida',
          icon: 'scroll-text',
          iconColor: '#a855f7',
          command: node(SCRIPTS.flood),
          env: RUN_AS_NODE,
        },
      ],
      actions: [
        {
          id: 'ok',
          name: 'Acción correcta',
          icon: 'check',
          iconColor: '#22c55e',
          command: 'echo accion de prueba completada',
        },
        {
          id: 'fail',
          name: 'Acción que falla',
          icon: 'x',
          iconColor: '#ef4444',
          command: sh.fail,
        },
        {
          id: 'slow',
          name: 'Acción lenta (5 s)',
          icon: 'hourglass',
          iconColor: '#f97316',
          command: node(SCRIPTS.slow),
          env: RUN_AS_NODE,
        },
      ],
    },
    {
      id: id('failures'),
      name: name('Fallos'),
      icon: 'bug',
      iconColor: '#ef4444',
      path: env.tmpDir,
      mode: 'multi',
      commands: [
        {
          id: 'exit-1',
          name: 'Sale con código 1',
          icon: 'circle-x',
          iconColor: '#ef4444',
          command: sh.exit1,
        },
        {
          id: 'missing-command',
          name: 'Comando inexistente',
          icon: 'ban',
          iconColor: '#6b7280',
          command: 'devbar-comando-que-no-existe --version',
        },
        {
          // A missing working directory fails the spawn itself.
          id: 'missing-cwd',
          name: 'Carpeta inexistente',
          icon: 'folder-x',
          iconColor: '#a16207',
          command: 'echo nunca llega a ejecutarse',
          cwd: sh.join(env.tmpDir, 'devbar-carpeta-que-no-existe'),
        },
      ],
    },
    {
      id: id('repo'),
      name: name(env.repoPath ? 'Repositorio' : 'Modo único'),
      icon: env.repoPath ? 'git-branch' : 'zap',
      iconColor: '#14b8a6',
      path: env.repoPath ?? env.tmpDir,
      mode: 'single',
      commands: [
        {
          id: 'tick',
          name: 'Cada segundo',
          icon: 'activity',
          iconColor: '#ec4899',
          command: node(SCRIPTS.tick),
          env: RUN_AS_NODE,
        },
        {
          id: 'alerts',
          name: 'Avisos y errores',
          icon: 'triangle-alert',
          iconColor: '#eab308',
          command: node(SCRIPTS.alerts),
          env: RUN_AS_NODE,
        },
      ],
    },
  ];
}

/** `repeat` copies of the fixture set, normalized like any stored group. */
export function buildFixtureGroups(
  env: FixtureEnvironment,
  repeat: number,
): Group[] {
  const copies = clampFixtureRepeat(repeat);
  const raw: unknown[] = [];
  for (let copy = 1; copy <= copies; copy++) raw.push(...fixtureSet(env, copy));
  return raw.map((group, order) =>
    normalizeGroup({ ...(group as object), order }),
  );
}
