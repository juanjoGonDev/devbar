import type { EnvEntry } from '../domain-types.js';

/**
 * The pre-scripts the dev panel's fixture workflows run (see
 * fixture-workflows.ts), in one group of their own: quick and slow steps,
 * one that warns, one that fails, one that outlives its time limit, one that
 * asks first and one that floods its log.
 *
 * Every one is a node script for the app's own binary in node mode, so the
 * waits and the output behave the same on every OS. Like the other fixture
 * scripts they stay clear of < > & | % ^ ! and double quotes, which cmd.exe
 * reinterprets even inside a quoted argument.
 */

/** Added once, whatever the copy count: every fixture workflow points here. */
export const FIXTURE_SCRIPTS_GROUP_ID = 'fixture-scripts';

/** `seconds` of waiting, one progress line every `step` (a divisor of it). */
function wait(seconds: number, step = 1): string {
  return (
    `var s=${seconds},p=${step},n=0;console.log('empieza: '+s+' s');` +
    "var t=setInterval(function(){n+=p;console.log('progreso '+n+'/'+s+' s');" +
    "if(n==s){clearInterval(t);console.log('listo')}},p*1000)"
  );
}

const QUICK =
  "console.log('paso rapido');setTimeout(function(){console.log('ok')},500)";
const WARN =
  "console.log('comprobando dependencias');setTimeout(function(){" +
  "console.log('warning: hay 2 dependencias obsoletas');" +
  "console.log('terminado con avisos')},800)";
const FAIL =
  "console.log('ejecutando paso');setTimeout(function(){" +
  "console.error('error: el paso de prueba falla');process.exit(1)},1000)";
const HANG =
  "console.log('espera 60 s y su limite son 3 s');" +
  "setInterval(function(){console.log('sigo esperando')},1000)";
const NOISY =
  "for(var i=1;i-1501;i++)console.log('linea '+i+' de 1500 '+'x'.repeat(50))";

interface ScriptSpec {
  id: string;
  name: string;
  script: string;
  timeoutMs?: number;
  confirm?: boolean;
  confirmSecs?: number;
}

function step(id: string, name: string, seconds: number): ScriptSpec {
  return { id, name, script: wait(seconds) };
}

/** The light steps the bigger graphs are made of: 1–3 s each. */
const STEPS: readonly ScriptSpec[] = [
  step('deps', 'Instalar dependencias', 2),
  step('docker', 'Levantar contenedores', 3),
  step('cache', 'Calentar caché', 1),
  step('build', 'Compilar', 3),
  step('lint', 'Lint', 1),
  step('tipos', 'Comprobar tipos', 2),
  step('test', 'Tests', 3),
  step('migrar', 'Migrar base de datos', 2),
  step('semillas', 'Cargar semillas', 1),
  step('assets', 'Generar assets', 2),
  step('docs', 'Generar documentación', 1),
  step('empaquetar', 'Empaquetar', 2),
  step('publicar', 'Publicar artefactos', 1),
  step('limpiar', 'Limpiar temporales', 1),
];

const SPECIAL: readonly ScriptSpec[] = [
  { id: 'rapido', name: 'Rápido (0,5 s)', script: QUICK },
  { id: 'lento-5', name: 'Lento (5 s)', script: wait(5) },
  { id: 'lento-15', name: 'Lento (15 s)', script: wait(15, 3) },
  { id: 'lento-40', name: 'Muy lento (40 s)', script: wait(40, 5) },
  { id: 'aviso', name: 'Termina con avisos', script: WARN },
  { id: 'falla', name: 'Falla (código 1)', script: FAIL },
  {
    id: 'timeout',
    name: 'Excede su tiempo límite (3 s)',
    script: HANG,
    timeoutMs: 3000,
  },
  {
    id: 'confirmar',
    name: 'Pide confirmación',
    script: QUICK,
    confirm: true,
    confirmSecs: 10,
  },
  { id: 'ruidoso', name: 'Mucha salida', script: NOISY },
];

/**
 * The scripts group, raw (the caller normalizes it). `node` turns a script
 * into the platform's command line for the app binary; `env` is what makes
 * that binary run as node.
 */
export function fixtureScriptsGroup(input: {
  path: string;
  node: (script: string) => string;
  env: readonly EnvEntry[];
}): unknown {
  return {
    id: FIXTURE_SCRIPTS_GROUP_ID,
    name: 'Scripts de prueba',
    icon: 'workflow',
    iconColor: '#6366f1',
    path: input.path,
    mode: 'multi',
    // Its warn pattern (the default) is what turns «aviso» into a warning:
    // a pre-script has no pattern of its own and borrows its group's.
    commands: [
      {
        id: 'tick',
        name: 'Servicio auxiliar',
        icon: 'activity',
        iconColor: '#6366f1',
        command: input.node(
          "var n=0;setInterval(function(){n++;console.log('auxiliar '+n)},2000)",
        ),
        env: input.env,
      },
    ],
    preScripts: [...SPECIAL, ...STEPS].map((spec) => ({
      id: spec.id,
      name: spec.name,
      command: input.node(spec.script),
      env: input.env,
      timeoutMs: spec.timeoutMs ?? null,
      confirm: spec.confirm === true,
      ...(spec.confirmSecs ? { confirmSecs: spec.confirmSecs } : {}),
    })),
  };
}
