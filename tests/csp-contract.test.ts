import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Uploaded icons are painted as `data:image/png` URLs, so every window that
 * shows user icons must allow data: images — and only images: a data: URL
 * must never be able to run as script or load as a frame.
 */

const RENDERER = path.join(import.meta.dirname, '..', 'renderer');

function csp(file: string): Map<string, string[]> {
  const html = fs.readFileSync(path.join(RENDERER, file), 'utf8');
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
    html,
  );
  if (!match?.[1]) throw new Error(`${file} has no CSP`);
  return new Map(
    match[1]
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...values]) => [name ?? '', values]),
  );
}

const WINDOWS = fs.readdirSync(RENDERER).filter((f) => f.endsWith('.html'));
/** The windows that call userIcon(). */
const USER_ICON_WINDOWS = ['tray.html', 'config.html', 'logs.html'];

describe('window content security policies', () => {
  it.each(USER_ICON_WINDOWS)('%s allows inline data: images', (file) => {
    expect(csp(file).get('img-src')).toEqual(["'self'", 'data:']);
  });

  it.each(WINDOWS)(
    '%s keeps default-src to self and no data: script',
    (file) => {
      const policy = csp(file);
      expect(policy.get('default-src')).toEqual(["'self'"]);
      for (const [name, values] of policy)
        if (name !== 'img-src') expect(values).not.toContain('data:');
    },
  );
});
