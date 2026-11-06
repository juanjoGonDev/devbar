import type { EntityDiff } from '../config-diff.js';
import type { UndoSlice } from '../config-changes.js';
import { prepareIcon } from './images.js';
import type { ImageInput } from './config-schemas.js';
import { ToolError, type ToolContext, type ToolOutcome } from './tool-kit.js';

/**
 * The one way an assistant's configuration change happens: nothing changed
 * means nothing is asked; otherwise the user confirms the diff in DevBar as
 * the client's config policy says (always by default, once per target, or
 * not at all), the whole config is backed up for the slice it touches, and
 * only then is the change written through the app's own handler. Whether it
 * was asked or not, the outcome carries the diff and the undo token the
 * audit log keeps.
 */

export interface ChangeRequest {
  title: string;
  subtitle: string;
  target: string;
  change: EntityDiff;
  reason?: string | undefined;
  slice: UndoSlice;
  /** Runs once confirmed; answers an error to report, or null. */
  write(): Promise<string | null>;
  /** What the assistant reads back on success. */
  data?: () => unknown;
}

export async function applyChange(
  ctx: ToolContext,
  request: ChangeRequest,
): Promise<ToolOutcome> {
  if (request.change.changed.length === 0)
    return {
      data: { ok: true, changed: false },
      target: request.target,
      summary: 'sin cambios',
    };
  await ctx.confirmChange({
    title: request.title,
    subtitle: request.subtitle,
    risk: request.change.risk,
    diff: request.change.diff,
    reason: request.reason,
  });
  const undoToken = ctx.changes.backup(request.slice);
  const error = await request.write();
  if (error) throw new ToolError(error, 'error', request.target);
  return {
    data: {
      ok: true,
      changed: request.change.changed,
      ...(request.data ? { result: request.data() } : {}),
    },
    target: request.target,
    summary: request.change.changed.join(', '),
    diff: request.change.diff,
    undoToken,
  };
}

/** An `image` becomes the icon, stored only when the change is applied. */
export async function iconFields(
  ctx: ToolContext,
  args: { icon?: string | undefined; image?: ImageInput | undefined },
): Promise<{ icon?: string; storeIcon: () => Promise<void> }> {
  if (!args.image)
    return {
      ...(args.icon !== undefined ? { icon: args.icon } : {}),
      storeIcon: () => Promise.resolve(),
    };
  const prepared = await prepareIcon(ctx.changes.port, args.image);
  return { icon: prepared.ref, storeIcon: () => prepared.store() };
}

/** The keys of `args` that were given, minus the tool's own parameters. */
export function given(
  args: Record<string, unknown>,
  skip: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) => value !== undefined && !skip.includes(key),
    ),
  );
}

/** What an `{ ok, error }` handler answer means for `write`. */
export function handlerError(result: unknown, fallback: string): string | null {
  if (result === null || result === undefined) return fallback;
  const outcome = result as { ok?: unknown; error?: unknown };
  if (outcome.ok === false)
    return typeof outcome.error === 'string' ? outcome.error : fallback;
  return null;
}
