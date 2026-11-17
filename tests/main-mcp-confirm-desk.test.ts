import { describe, expect, it } from 'vitest';
import type {
  McpConfirmClosed,
  McpConfirmRequest,
  McpRisk,
} from '../src/ipc-contract/mcp-api.js';
import {
  CONFIRM_TIMEOUT_MS,
  createConfirmDesk,
  type ConfirmAsk,
  type ConfirmOutcome,
} from '../src/main/mcp/confirm-desk.js';

function harness() {
  let ids = 0;
  const requested: McpConfirmRequest[] = [];
  const closed: McpConfirmClosed[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const desk = createConfirmDesk({
    now: () => 1000,
    newId: () => `r${++ids}`,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    requested: (request) => requested.push(request),
    closed: (entry) => closed.push(entry),
  });
  return { desk, requested, closed, timers };
}

const RISK: McpRisk = 'executes';
const ASK: ConfirmAsk = {
  clientName: 'Claude Code',
  title: 'Claude Code quiere cambiar un comando',
  subtitle: 'Grupo Back · comando Normal',
  risk: RISK,
  diff: [{ kind: 'add', field: 'comando', text: 'pnpm dev --inspect' }],
  reason: 'Depurar la fuga',
};

describe('src/main/mcp/confirm-desk.ts', () => {
  it('pushes the request with its id and deadline', () => {
    const h = harness();

    const { id } = h.desk.ask(ASK);

    expect(h.requested).toEqual([
      { ...ASK, id, expiresAt: 1000 + CONFIRM_TIMEOUT_MS },
    ]);
    expect(h.desk.pending().map((r) => r.id)).toEqual([id]);
  });

  it.each<['apply' | 'reject', ConfirmOutcome]>([
    ['apply', 'applied'],
    ['reject', 'rejected'],
  ])('settles with %s', async (answer, outcome) => {
    const h = harness();
    const asked = h.desk.ask(ASK);

    expect(h.desk.answer(asked.id, answer)).toEqual({ ok: true });

    await expect(asked.outcome).resolves.toBe(outcome);
    expect(h.closed).toEqual([{ id: asked.id, outcome }]);
    expect(h.desk.pending()).toEqual([]);
    expect(h.timers[0]?.cleared).toBe(true);
  });

  it('rejects on its own when nobody answers in time', async () => {
    const h = harness();
    const asked = h.desk.ask(ASK);

    expect(h.timers[0]?.ms).toBe(CONFIRM_TIMEOUT_MS);
    h.timers[0]?.fn();

    await expect(asked.outcome).resolves.toBe('expired');
    expect(h.desk.answer(asked.id, 'apply')).toEqual({
      ok: false,
      error: 'Esa confirmación ya no está pendiente',
    });
  });

  it('cancels everything still waiting', async () => {
    const h = harness();
    const first = h.desk.ask(ASK);
    const second = h.desk.ask(ASK);

    h.desk.cancelAll();

    await expect(first.outcome).resolves.toBe('cancelled');
    await expect(second.outcome).resolves.toBe('cancelled');
    expect(h.closed.map((c) => c.outcome)).toEqual(['cancelled', 'cancelled']);
  });

  it('hands out copies, so a window cannot edit a pending request', () => {
    const h = harness();
    h.desk.ask(ASK);

    const [copy] = h.desk.pending();
    if (copy) copy.title = 'changed';

    expect(h.desk.pending()[0]?.title).toBe(ASK.title);
  });
});
