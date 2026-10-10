// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { watchCustomIcons } from '../renderer/custom-icons.js';
import { userIcon } from '../renderer/icon.js';
import type { CustomIcon } from '../src/domain-types.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const logo: CustomIcon = { id: 'abc123', name: 'logo', dataUrl: PNG };

function stubApi(list: Promise<CustomIcon[]>) {
  let push: ((icons: CustomIcon[]) => void) | null = null;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listCustomIcons: () => list,
      onCustomIconsChanged: (cb: (icons: CustomIcon[]) => void) => {
        push = cb;
        return () => undefined;
      },
    },
  });
  return { push: (icons: CustomIcon[]) => push?.(icons) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renderer/custom-icons.ts', () => {
  it('loads the library, then repaints', async () => {
    stubApi(Promise.resolve([logo]));
    let repaints = 0;
    watchCustomIcons(() => repaints++);
    await flush();
    expect(repaints).toBe(1);
    expect(userIcon('img:abc123', 'package').className).toBe('icon icon-img');
  });

  it('follows every change main pushes', async () => {
    const api = stubApi(Promise.resolve([]));
    let repaints = 0;
    watchCustomIcons(() => repaints++);
    await flush();
    api.push([logo]);
    expect(repaints).toBe(2);
    expect(userIcon('img:abc123', 'package').className).toBe('icon icon-img');
    api.push([]);
    expect(userIcon('img:abc123', 'package').dataset.icon).toBe('package');
  });

  it('repaints image references already on screen, in place', async () => {
    const api = stubApi(Promise.resolve([]));
    watchCustomIcons();
    await flush();
    document.body.replaceChildren(
      userIcon('img:abc123', 'terminal', '#22c55e'),
      userIcon('rocket', 'package'),
    );
    expect(document.body.firstElementChild?.getAttribute('data-icon')).toBe(
      'terminal',
    );
    api.push([logo]);
    const [image, glyph] = [...document.body.children] as HTMLElement[];
    expect(image?.className).toBe('icon icon-img');
    expect(image?.dataset.customIcon).toBe('img:abc123');
    expect(glyph?.dataset.icon).toBe('rocket');
    api.push([]);
    const fallback = document.body.firstElementChild as HTMLElement;
    expect(fallback.dataset.icon).toBe('terminal');
    expect(fallback.style.color).toBe('rgb(34, 197, 94)');
  });

  it('keeps painting fallbacks when the library cannot load', async () => {
    stubApi(Promise.reject(new Error('no ipc')));
    let repaints = 0;
    watchCustomIcons(() => repaints++);
    await flush();
    expect(repaints).toBe(0);
  });
});
