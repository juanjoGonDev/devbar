// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { auditEntry, click, el, visible } from './helpers/mcp.js';
import { auditPage, lastQuery, openActivity } from './helpers/mcp-activity.js';
import type { RendererWindow } from './helpers/renderer-dom.js';
import { pageNumbers } from '../renderer/config/mcp-activity-pager.js';

/**
 * The foot of «Actividad» (renderer/config/mcp-activity-pager.ts): which
 * entries are on screen, the page buttons and how many per page.
 */

const LIST = Array.from({ length: 50 }, (_, i) => auditEntry(`a${i}`));
const BIG = auditPage(LIST, { total: 1284, retained: 1284 });

const pages = (): string[] =>
  [...el('mcp-activity-pages').children].map(
    (child) => child.getAttribute('aria-label') ?? visible(child),
  );
const page = (label: string): HTMLButtonElement => {
  const found = el('mcp-activity-pages').querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`no ${label}`);
  return found;
};

describe('renderer/config/mcp-activity-pager.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  it.each<[number, number, (number | null)[]]>([
    [1, 1, [1]],
    [1, 26, [1, 2, null, 26]],
    [3, 26, [1, 2, 3, 4, null, 26]],
    [13, 26, [1, null, 12, 13, 14, null, 26]],
    [26, 26, [1, null, 25, 26]],
  ])('offers page %d of %d as %j', (current, count, expected) => {
    expect(pageNumbers(current, count)).toEqual(expected);
  });

  it('says which entries are on screen out of how many', async () => {
    win = await openActivity(BIG);
    expect(visible(el('mcp-activity-range'))).toBe('1–50 de 1284');
    expect(pages()).toEqual([
      'Página anterior',
      'Página 1',
      'Página 2',
      '…',
      'Página 26',
      'Página siguiente',
    ]);
    expect(page('Página 1').getAttribute('aria-current')).toBe('page');
    expect(page('Página anterior').disabled).toBe(true);
  });

  it('moves between pages without losing the filters', async () => {
    win = await openActivity(BIG);
    click(page('Página siguiente'));
    expect(lastQuery(win)).toMatchObject({ offset: 50, limit: 50 });
    await win.settle('queryMcpAudit', BIG);
    expect(visible(el('mcp-activity-range'))).toBe('51–100 de 1284');
    click(page('Página 26'));
    expect(lastQuery(win).offset).toBe(1250);
    await win.settle(
      'queryMcpAudit',
      auditPage(LIST.slice(0, 34), { total: 1284, retained: 1284 }),
    );
    expect(visible(el('mcp-activity-range'))).toBe('1251–1284 de 1284');
    expect(page('Página siguiente').disabled).toBe(true);
    click(page('Página anterior'));
    expect(lastQuery(win).offset).toBe(1200);
  });

  it('starts over on page 1 with another page size', async () => {
    win = await openActivity(BIG);
    click(page('Página 2'));
    await win.settle('queryMcpAudit', BIG);
    const size = el<HTMLSelectElement>('mcp-activity-size');
    expect(size.value).toBe('50');
    size.value = '100';
    size.dispatchEvent(new Event('change'));
    expect(lastQuery(win)).toMatchObject({ offset: 0, limit: 100 });
  });

  it('goes to the last page when the one it was on has emptied', async () => {
    win = await openActivity(BIG);
    click(page('Página 26'));
    await win.settle(
      'queryMcpAudit',
      auditPage([], { total: 60, retained: 60 }),
    );
    expect(lastQuery(win).offset).toBe(50);
    expect(win.callCount('queryMcpAudit')).toBe(3);
  });
});
