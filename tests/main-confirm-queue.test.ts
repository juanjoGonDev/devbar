import { describe, expect, it, vi } from 'vitest';
import {
  createConfirmQueue,
  type ConfirmWindowLike,
} from '../src/main/confirm-queue.js';
import { makeCommand, makeGroup, makePreScript } from './helpers/main-fakes.js';

interface Timer {
  fire: () => void;
  cleared: boolean;
}

function harness() {
  const windows: {
    token: string;
    win: ConfirmWindowLike & { closed: boolean };
  }[] = [];
  const timers: Timer[] = [];
  let seq = 0;
  const queue = createConfirmQueue({
    openWindow: (token) => {
      const win = {
        closed: false,
        isDestroyed: () => win.closed,
        close: () => {
          win.closed = true;
        },
      };
      windows.push({ token, win });
      return win;
    },
    logo: () => 'data:image/png;base64,LOGO',
    newToken: () => `t${++seq}`,
    setTimer: (fn) => {
      const timer: Timer = { fire: fn, cleared: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => {
      (timer as unknown as Timer).cleared = true;
    },
  });
  return { queue, windows, timers };
}

const script = makePreScript({
  name: 'vpn',
  command: 'connect',
  args: ['--fast'],
});

/** Let the serial chain's microtasks run so the next modal actually opens. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('src/main/confirm-queue.ts', () => {
  describe('showConfirmModal', () => {
    it('registers the context BEFORE opening the window', () => {
      const { queue, windows } = harness();
      void queue.showConfirmModal(script, 'pipeline', 'API');
      expect(queue.getContext(windows[0]?.token ?? '')).toMatchObject({
        name: 'vpn',
        command: 'connect --fast',
        groupName: 'API',
        logo: 'data:image/png;base64,LOGO',
      });
    });

    it('resolves true on a confirm and closes the window', async () => {
      const { queue, windows } = harness();
      const pending = queue.showConfirmModal(script, 'pipeline', null);
      queue.resolveConfirm('t1', 'confirm');
      await expect(pending).resolves.toBe(true);
      expect(windows[0]?.win.closed).toBe(true);
    });

    it('resolves false on a cancel', async () => {
      const { queue } = harness();
      const pending = queue.showConfirmModal(script, 'pipeline', null);
      queue.resolveConfirm('t1', 'cancel');
      await expect(pending).resolves.toBe(false);
    });

    it('is safe to resolve twice', async () => {
      const { queue } = harness();
      const pending = queue.showConfirmModal(script, 'pipeline', null);
      queue.resolveConfirm('t1', 'confirm');
      queue.resolveConfirm('t1', 'cancel');
      await expect(pending).resolves.toBe(true);
    });

    it('arms no timer without a countdown', () => {
      const { queue, timers } = harness();
      void queue.showConfirmModal(script, 'pipeline', null);
      expect(timers).toHaveLength(0);
    });

    it('lets the authoritative timer decide when nobody answers', async () => {
      const { queue, timers } = harness();
      const pending = queue.showConfirmModal(
        makePreScript({ confirmSecs: 10, confirmOnTimeout: 'confirm' }),
        'pipeline',
        null,
      );
      timers[0]?.fire();
      await expect(pending).resolves.toBe(true);
    });

    it('clears the timer when a human answers first', () => {
      const { queue, timers } = harness();
      void queue.showConfirmModal(
        makePreScript({ confirmSecs: 10 }),
        'pipeline',
        null,
      );
      queue.resolveConfirm('t1', 'confirm');
      expect(timers[0]?.cleared).toBe(true);
    });
  });

  describe('getContext / hasPending', () => {
    it('knows nothing about an unknown token', () => {
      const { queue } = harness();
      expect(queue.getContext('nope')).toBeNull();
      expect(queue.hasPending('nope')).toBe(false);
    });

    it('forgets the token once it resolves', () => {
      const { queue } = harness();
      void queue.showConfirmModal(script, 'pipeline', null);
      expect(queue.hasPending('t1')).toBe(true);
      queue.resolveConfirm('t1', 'cancel');
      expect(queue.hasPending('t1')).toBe(false);
    });
  });

  describe('serial queue', () => {
    it('shows only one modal at a time', async () => {
      const { queue, windows } = harness();
      const first = queue.confirmScript(script, null);
      const second = queue.confirmScript(script, null);
      await tick();
      expect(windows).toHaveLength(1);
      queue.resolveConfirm('t1', 'confirm');
      await expect(first).resolves.toBe(true);
      await tick();
      expect(windows).toHaveLength(2);
      queue.resolveConfirm('t2', 'confirm');
      await expect(second).resolves.toBe(true);
    });
  });

  describe('cancelConfirm', () => {
    it('declines every pending pipeline confirmation', async () => {
      const { queue } = harness();
      const pending = queue.confirmScript(script, makeGroup());
      await tick();
      queue.cancelConfirm();
      await expect(pending).resolves.toBe(false);
    });

    it('pre-empts a pipeline job still queued behind the chain', async () => {
      const { queue, windows } = harness();
      const first = queue.confirmScript(script, null);
      await tick();
      const second = queue.confirmScript(script, null);
      queue.cancelConfirm();
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      // The queued job declined instead of opening a second modal.
      expect(windows).toHaveLength(1);
    });

    it('leaves an interactive confirmation alone', async () => {
      const { queue } = harness();
      const pending = queue.confirmIfNeeded(
        makeCommand({ confirm: true }),
        makeGroup(),
      );
      await tick();
      queue.cancelConfirm();
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await tick();
      expect(settled).toBe(false);
      queue.resolveConfirm('t1', 'confirm');
      await expect(pending).resolves.toBe(true);
    });

    it('does not pre-empt an interactive job queued behind a cancel', async () => {
      const { queue, windows } = harness();
      const pipeline = queue.confirmScript(script, null);
      await tick();
      const interactive = queue.confirmIfNeeded(
        makeCommand({ confirm: true }),
        null,
      );
      queue.cancelConfirm();
      await expect(pipeline).resolves.toBe(false);
      await tick();
      expect(windows).toHaveLength(2);
      queue.resolveConfirm('t2', 'confirm');
      await expect(interactive).resolves.toBe(true);
    });
  });

  describe('confirmIfNeeded', () => {
    it('lets an unguarded target through without a modal', async () => {
      const { queue, windows } = harness();
      await expect(queue.confirmIfNeeded(makeCommand(), null)).resolves.toBe(
        true,
      );
      await expect(queue.confirmIfNeeded(null, null)).resolves.toBe(true);
      await expect(queue.confirmIfNeeded(undefined, null)).resolves.toBe(true);
      expect(windows).toHaveLength(0);
    });

    it('shows the target command with its arguments and group', async () => {
      const { queue } = harness();
      void queue.confirmIfNeeded(
        makeCommand({ confirm: true, command: 'rm', args: ['-rf', 'build'] }),
        makeGroup({ name: 'API' }),
      );
      await tick();
      expect(queue.getContext('t1')).toMatchObject({
        command: 'rm -rf build',
        groupName: 'API',
      });
    });
  });

  describe('defaults', () => {
    it('mints a real token and uses real timers when none are injected', async () => {
      const opened: string[] = [];
      const queue = createConfirmQueue({
        openWindow: (token) => {
          opened.push(token);
          return { isDestroyed: () => false, close: vi.fn() };
        },
        logo: () => '',
      });
      const pending = queue.showConfirmModal(
        makePreScript({ confirmSecs: 0, confirmOnTimeout: 'cancel' }),
        'interactive',
        null,
      );
      await expect(pending).resolves.toBe(false);
      expect(opened[0]).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
