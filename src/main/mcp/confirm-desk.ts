import type {
  McpConfirmAnswer,
  McpConfirmClosed,
  McpConfirmRequest,
} from '../../ipc-contract/mcp-api.js';
import type { SimpleResult } from '../../ipc-contract/simple-result.js';

/**
 * The calls of an assistant that wait for the user: each one is pushed to the
 * windows as a `McpConfirmRequest`, and the tool call stays open until the
 * user applies or rejects it in DevBar. Nobody answering is a «no»: after
 * `CONFIRM_TIMEOUT_MS` it is rejected on its own, so an assistant never
 * changes anything because the user was away.
 */

export const CONFIRM_TIMEOUT_MS = 60_000;

export type ConfirmOutcome = McpConfirmClosed['outcome'];

export interface ConfirmDeskDeps {
  now(): number;
  newId(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** A new request: show it to the user. */
  requested(request: McpConfirmRequest): void;
  closed(closed: McpConfirmClosed): void;
}

export type ConfirmAsk = Omit<McpConfirmRequest, 'id' | 'expiresAt'>;

export interface ConfirmDesk {
  /** Resolves when the user answers, the request expires or is cancelled. */
  ask(request: ConfirmAsk): { id: string; outcome: Promise<ConfirmOutcome> };
  answer(id: string, answer: McpConfirmAnswer): SimpleResult;
  pending(): McpConfirmRequest[];
  /** Ends every open request as `cancelled` (the server stopped). */
  cancelAll(): void;
}

interface Open {
  request: McpConfirmRequest;
  timer: unknown;
  settle(outcome: ConfirmOutcome): void;
}

export function createConfirmDesk(deps: ConfirmDeskDeps): ConfirmDesk {
  const open = new Map<string, Open>();

  const close = (id: string, outcome: ConfirmOutcome): boolean => {
    const entry = open.get(id);
    if (!entry) return false;
    open.delete(id);
    deps.clearTimer(entry.timer);
    entry.settle(outcome);
    deps.closed({ id, outcome });
    return true;
  };

  return {
    ask: (ask) => {
      const id = deps.newId();
      const request: McpConfirmRequest = {
        ...ask,
        id,
        expiresAt: deps.now() + CONFIRM_TIMEOUT_MS,
      };
      let settle: (outcome: ConfirmOutcome) => void = () => undefined;
      const outcome = new Promise<ConfirmOutcome>((resolve) => {
        settle = resolve;
      });
      const timer = deps.setTimer(
        () => close(id, 'expired'),
        CONFIRM_TIMEOUT_MS,
      );
      open.set(id, { request, timer, settle });
      deps.requested(structuredClone(request));
      return { id, outcome };
    },
    answer: (id, answer) =>
      close(id, answer === 'apply' ? 'applied' : 'rejected')
        ? { ok: true }
        : { ok: false, error: 'Esa confirmación ya no está pendiente' },
    pending: () =>
      [...open.values()].map((entry) => structuredClone(entry.request)),
    cancelAll: () => {
      for (const id of [...open.keys()]) close(id, 'cancelled');
    },
  };
}
