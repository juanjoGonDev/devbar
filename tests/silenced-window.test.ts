// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';

function silencedFor(name: string, patterns: string[]): unknown {
  return {
    ok: true,
    group: { id: 'group-1', name: 'grupo' },
    command: {
      id: 'command-1',
      name,
      silencedPatterns: { warn: patterns, error: [] },
    },
  };
}

function warnPatterns(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#silenced-warns .pattern'),
    (el) => el.textContent ?? '',
  );
}

describe('renderer/silenced.ts', () => {
  let silenced: RendererWindow | null = null;

  beforeEach(() => {
    // The window identifies its command through the query string, which it
    // reads once at import time.
    history.replaceState(null, '', '?groupId=group-1&commandId=command-1');
  });

  afterEach(() => {
    silenced?.close();
    silenced = null;
  });

  async function openSilenced(): Promise<RendererWindow> {
    silenced = await loadRendererWindow({
      html: 'silenced.html',
      load: () => import('../renderer/silenced.js'),
      values: { platform: 'macos' },
    });
    return silenced;
  }

  describe('command snapshot', () => {
    it('renders the read when nothing newer has landed', async () => {
      const win = await openSilenced();
      await win.settle('getSilencedForCommand', silencedFor('api', ['ruido']));
      expect(document.getElementById('title')?.textContent).toBe(
        'Silenciados — api',
      );
      expect(warnPatterns()).toEqual(['ruido']);
    });

    it('keeps the newer snapshot when an older one resolves after it', async () => {
      // `onUpdate` re-enters `load()` on every push without waiting for the
      // one still in flight — and a pattern added here is exactly what
      // triggers that push, so the two overlap on the user's own click.
      const win = await openSilenced();
      await win.push('onUpdate');
      expect(
        win.callCount('getSilencedForCommand'),
        'the pushed read must overlap the boot one',
      ).toBe(2);
      await win.settleNewest(
        'getSilencedForCommand',
        silencedFor('api', ['ruido', 'nuevo']),
      );
      await win.settle('getSilencedForCommand', silencedFor('api', ['ruido']));
      expect(warnPatterns()).toEqual(['ruido', 'nuevo']);
    });
  });
});
