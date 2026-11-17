// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditEntry, click, el } from './helpers/mcp.js';
import {
  auditPage,
  checkbox,
  funnel,
  openActivity,
  sortButton,
  toggle,
} from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import { LIVE_DELAY_MS } from '../renderer/config/mcp-activity.js';
import type { McpAuditPage } from '../src/ipc-contract/mcp-api.js';

/**
 * Only the rows of «Actividad» scroll (renderer/config/mcp-activity.ts and
 * renderer/styles.css): a new question — another page, page size, filter,
 * sort or search — shows its answer from the top, and the list says it is
 * scrolled with `.is-scrolled` (the shade under the header). jsdom has no
 * layout, so this drives `scrollTop` and the scroll event by hand.
 */

const LIST = Array.from({ length: 50 }, (_, i) => auditEntry(`a${i}`));
const BIG = auditPage(LIST, { total: 300, retained: 300 });

const rows = (): HTMLUListElement => el<HTMLUListElement>('mcp-activity-rows');

function scrollTo(top: number): void {
  rows().scrollTop = top;
  rows().dispatchEvent(new Event('scroll'));
}

function search(text: string): void {
  const input = el<HTMLInputElement>('mcp-activity-search');
  input.value = text;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
  );
}

describe('renderer/config/mcp-activity.ts (scrolling)', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    vi.useRealTimers();
    win?.close();
    win = null;
  });

  it('marks the rows as scrolled while they are off the top', async () => {
    win = await openActivity(BIG);
    expect(rows().classList.contains('is-scrolled')).toBe(false);
    scrollTo(120);
    expect(rows().classList.contains('is-scrolled')).toBe(true);
    scrollTo(0);
    expect(rows().classList.contains('is-scrolled')).toBe(false);
  });

  it.each<[string, () => void]>([
    [
      'another page',
      () =>
        click(
          el('mcp-activity-pages').querySelector('[aria-label="Página 2"]'),
        ),
    ],
    [
      'another page size',
      () => {
        const size = el<HTMLSelectElement>('mcp-activity-size');
        size.value = '100';
        size.dispatchEvent(new Event('change'));
      },
    ],
    [
      'a column filter',
      () => {
        click(funnel('Resultado'));
        toggle(checkbox('Error'));
      },
    ],
    ['a sort', () => click(sortButton('Cliente'))],
    ['a search', () => search('logs')],
  ])('shows the answer to %s from the top', async (_what, ask) => {
    win = await openActivity(BIG);
    scrollTo(240);
    ask();
    // The old rows stay where they were until the answer arrives.
    expect(rows().scrollTop).toBe(240);
    await win.settle('queryMcpAudit', BIG);
    expect(rows().scrollTop).toBe(0);
    expect(rows().classList.contains('is-scrolled')).toBe(false);
  });

  it('keeps the place when new calls only refresh the same page', async () => {
    win = await openActivity(BIG);
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
    });
    scrollTo(240);
    await win.push('onMcpAudit', auditEntry('fresh'));
    await vi.advanceTimersByTimeAsync(LIVE_DELAY_MS);
    const refreshed: McpAuditPage = auditPage(LIST, {
      total: 301,
      retained: 301,
    });
    await win.settle('queryMcpAudit', refreshed);
    expect(rows().scrollTop).toBe(240);
    expect(rows().classList.contains('is-scrolled')).toBe(true);
  });
});
