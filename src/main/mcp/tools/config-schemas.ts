import { z } from 'zod';

/**
 * The input shapes of the configuration tools. They check types and ranges so
 * an assistant gets a precise error early; the app's own normalizers and
 * validators (the ones Settings goes through) still have the last word.
 */

export const reason = z
  .string()
  .max(500)
  .optional()
  .describe('Why, in a few words: shown to the user next to the diff.');

const env = z
  .union([
    z.record(z.string(), z.string()),
    z.array(
      z.object({
        key: z.string().min(1),
        value: z.string(),
        enabled: z.boolean().optional(),
      }),
    ),
  ])
  .describe(
    'Environment variables: `{ "KEY": "value" }` or `[{ key, value, enabled }]`. Replaces the whole list.',
  );

const image = z
  .object({
    base64: z
      .string()
      .min(1)
      .max(7_000_000)
      .describe('The file, base64-encoded.'),
    mime: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']),
    name: z.string().max(80).optional(),
  })
  .describe(
    'An image to use as the icon (PNG/JPEG up to 5 MB, SVG up to 1 MB); scaled to 64 px and stored in the icon library.',
  );

const icon = z
  .string()
  .min(1)
  .max(100)
  .describe(
    'A Lucide icon name (e.g. "server", "database"), or `img:<id>` for an uploaded image.',
  );

const iconColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable()
  .describe('`#rrggbb`, or null to follow the text colour.');

const days = z
  .array(z.number().int().min(0).max(6))
  .describe('0 = Sunday … 6 = Saturday; [] = every day.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const interval = z.object({
  every: z.number().int().min(1).max(10_000),
  unit: z.enum(['minutes', 'hours', 'days']),
  window: z.object({ from: time, to: time }).nullable().optional(),
  days: days.optional(),
});

const rules = z.array(z.object({ time, days }));

const schedule = z
  .object({
    enabled: z.boolean(),
    rules: rules.optional(),
    interval: interval.nullable().optional(),
  })
  .describe(
    'When it runs on its own: weekday + time rules, or an interval («cada N»).',
  );

const confirmFields = {
  confirm: z.boolean().optional().describe('Ask in DevBar before each start.'),
  confirmSecs: z.number().int().min(1).max(3600).nullable().optional(),
  confirmOnTimeout: z.enum(['confirm', 'cancel']).optional(),
};

const runFields = {
  command: z.string().min(1).max(10_000).describe('The command line.'),
  args: z.array(z.string().max(10_000)).max(200).optional(),
  env: env.optional(),
};

export const GROUP_INPUT = {
  name: z.string().min(1).max(200).optional(),
  icon: icon.optional(),
  iconColor: iconColor.optional(),
  image: image.optional(),
  folder: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe('The project folder (`~` allowed).'),
  mode: z
    .enum(['single', 'multi'])
    .optional()
    .describe('`single`: one command at a time.'),
  env: env.optional(),
  hiddenInTray: z.boolean().optional(),
  waitForPipeline: z.boolean().optional(),
};

export const COMMAND_INPUT = {
  name: z.string().min(1).max(200).optional(),
  icon: icon.optional(),
  iconColor: iconColor.optional(),
  image: image.optional(),
  ...runFields,
  command: runFields.command.optional(),
  cwd: z
    .string()
    .max(4096)
    .nullable()
    .optional()
    .describe('Working folder; null = the group folder.'),
  autoStart: z.boolean().optional(),
  schedule: schedule.optional(),
  link: z
    .object({
      mode: z.enum(['auto', 'custom', 'none']),
      path: z.string().max(2000).optional(),
      url: z.string().max(2000).optional(),
    })
    .optional(),
  warnRegex: z.string().max(1000).optional(),
  errorRegex: z.string().max(1000).optional(),
  maxLogLines: z.number().int().min(100).max(50_000).nullable().optional(),
  ...confirmFields,
};

export const ACTION_INPUT = {
  name: z.string().min(1).max(200).optional(),
  icon: icon.optional(),
  iconColor: iconColor.optional(),
  image: image.optional(),
  ...runFields,
  command: runFields.command.optional(),
  inheritGroupEnv: z.boolean().optional(),
  schedule: schedule.optional(),
  ...confirmFields,
};

export const PRESCRIPT_INPUT = {
  name: z.string().min(1).max(200).optional(),
  ...runFields,
  command: runFields.command.optional(),
  inheritGroupEnv: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(86_400_000).nullable().optional(),
  ...confirmFields,
};

const trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), confirm: z.boolean().optional() }),
  z.object({ kind: z.literal('startup') }),
  z.object({
    kind: z.literal('schedule'),
    schedule: z.object({
      rules: rules.optional(),
      interval: interval.nullable().optional(),
    }),
  }),
]);

const graph = z
  .object({
    blocks: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          scripts: z
            .array(z.object({ group: z.string(), script: z.string() }))
            .min(1)
            .describe(
              'Pre-scripts by group and script id or name; two or more run in parallel.',
            ),
          requireAll: z
            .boolean()
            .optional()
            .describe(
              '«Todos OK» (default true): one failure fails the block.',
            ),
          x: z.number().optional(),
          y: z.number().optional(),
        }),
      )
      .max(200),
    edges: z
      .array(z.object({ from: z.string(), to: z.string() }))
      .max(1000)
      .describe(
        '`to` waits for `from`; `from` may be "trigger". A block with no incoming edge never runs.',
      ),
  })
  .describe('The pre-script graph (a DAG). Replaces the whole graph.');

export const WORKFLOW_INPUT = {
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  hidden: z.boolean().optional(),
  trigger: trigger.optional(),
  graph: graph.optional(),
};

export type GraphInput = z.infer<typeof graph>;
export type TriggerInput = z.infer<typeof trigger>;
export type ImageInput = z.infer<typeof image>;
