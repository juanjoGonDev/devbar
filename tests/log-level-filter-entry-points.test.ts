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
 * Collapse every run of whitespace to one space. These assertions are about
 * WHAT the source says, not where Prettier's 80-column wrap happens to break
 * it — adding a property or renaming an identifier must not redden them.
 */
function normalize(source: string): string {
  return source.replace(/\s+/gu, ' ');
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
    expect(normalize(counterBtn)).toContain(
      'openLogs({ processId, level: kind })',
    );
  });

  it('the tray counter badge never pre-fills the text search', () => {
    // The contract is not one regex SPELLING: ANY filter handed to openLogs
    // lands in the text box the level chip replaced. So the button must not
    // mention a filter at all, and its only openLogs call must carry nothing
    // but the process id and the level.
    expect(normalize(counterBtn)).not.toMatch(/\bfilter\b/u);
    const openLogsArgs = Array.from(
      counterBtn.matchAll(/openLogs\(([^)]*)\)/gu),
    ).map((match) => normalize(match[1] ?? '').trim());
    expect(openLogsArgs).toEqual(['{ processId, level: kind }']);
  });

  const ensureLogsWindow = functionSource(
    read('src/main.ts'),
    'ensureLogsWindow',
  );

  it('main forwards the level when re-selecting an open window', () => {
    expect(normalize(ensureLogsWindow)).toContain(
      "existing.webContents.send('logs:select', { processId, filter, level });",
    );
  });

  it('main puts the level in the window URL query', () => {
    expect(normalize(ensureLogsWindow)).toContain(
      'if (level) query.level = level;',
    );
  });

  const selectLog = functionSource(read('renderer/logs.ts'), 'selectLog');

  it('the logs window pins the level chip when selectLog receives one', () => {
    expect(normalize(selectLog)).toContain('level?: SilenceLevel');
    expect(normalize(selectLog)).toContain(
      'if (level) setLevelFilter([level]);',
    );
  });
});
