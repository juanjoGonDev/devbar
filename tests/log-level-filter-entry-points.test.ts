import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every warn/error entry point (tray counters, alert totals, in-window nav)
// must open the logs through the LEVEL CHIP filter — the "sólo ⚠ warnings"
// pill — and never by pre-filling the text search with a regex. The chip is
// visible, removable (its ✕) and behaves identically on every OS; the text
// box is for manual searching. This test pins that contract at the source
// level, the same way renderer-dom-contract pins DOM assertions.

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function read(rel: string): string {
  return fs.readFileSync(path.join(repoDir, rel), 'utf8');
}

/**
 * Extract a top-level function's source by name. The body scan starts after
 * the parameter list's closing paren, so destructured params
 * (`{ filter, level }`) are not mistaken for the body.
 */
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  let i = start;
  let parenDepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') parenDepth++;
    else if (source[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) break; // end of the parameter list
    }
  }
  const bodyStart = source.indexOf('{', i);
  expect(bodyStart, `body of ${name} not found`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

describe('warn/error entry points open logs with the level chip', () => {
  const counterBtn = functionSource(
    read('renderer/tray.ts'),
    'buildCounterBtn',
  );

  it('the tray counter badge passes the level to openLogs', () => {
    expect(counterBtn).toContain('openLogs({ processId, level: kind })');
  });

  it('the tray counter badge no longer ships a warn/error regex filter', () => {
    expect(counterBtn).not.toContain('warn(ing)?s?');
    expect(counterBtn).not.toContain('error(s)?');
    expect(counterBtn).not.toContain('filter:');
  });

  const ensureLogsWindow = functionSource(
    read('src/main.ts'),
    'ensureLogsWindow',
  );

  it('main forwards the level when re-selecting an open window', () => {
    expect(ensureLogsWindow).toContain(
      "existing.webContents.send('logs:select', { processId, filter, level });",
    );
  });

  it('main puts the level in the window URL query', () => {
    expect(ensureLogsWindow).toContain('if (level) query.level = level;');
  });

  const selectLog = functionSource(read('renderer/logs.ts'), 'selectLog');

  it('the logs window pins the level chip when selectLog receives one', () => {
    expect(selectLog).toContain('level?: SilenceLevel');
    expect(selectLog).toContain('if (level) setLevelFilter([level]);');
  });
});
