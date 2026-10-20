import { describe, expect, it } from 'vitest';

import {
  addToTally,
  crumbsFor,
  runPillFor,
  tallyLevels,
  type CrumbSource,
} from '../renderer/logs/toolbar-model.js';
import type { LogEntry } from '../src/domain-types.js';
import type { LogListItem } from '../src/ipc-contract.js';

function item(overrides: Partial<LogListItem> = {}): LogListItem {
  return {
    id: 'api',
    type: 'command',
    name: 'api',
    icon: null,
    iconColor: null,
    lineCount: 0,
    status: 'stopped',
    warnCount: 0,
    errorCount: 0,
    startedAt: null,
    lastFinishedAt: null,
    logLimit: 5000,
    ...overrides,
  };
}

function source(overrides: Partial<CrumbSource> = {}): CrumbSource {
  return {
    processId: null,
    mergedIsAll: false,
    mergedGroupId: null,
    groupName: '',
    displayName: '',
    ...overrides,
  };
}

function line(extra: Partial<LogEntry> = {}): LogEntry {
  return { ts: 0, stream: 'stdout', level: null, line: 'x', ...extra };
}

describe('renderer/logs/toolbar-model.ts', () => {
  describe('crumbsFor', () => {
    it('qualifies a service with its group', () => {
      expect(
        crumbsFor(
          source({
            processId: 'g1:api',
            groupName: 'Back',
            displayName: 'api',
          }),
        ),
      ).toEqual({ group: 'Back', name: 'api' });
    });

    it('drops the qualifier when there is no group', () => {
      expect(
        crumbsFor(source({ processId: 'api', displayName: 'api' })),
      ).toEqual({ group: null, name: 'api' });
    });

    it('falls back to the id while the name is not known yet', () => {
      expect(crumbsFor(source({ processId: 'g1:api' })).name).toBe('g1:api');
    });

    it('names just the group for a whole group merged', () => {
      expect(
        crumbsFor(
          source({
            mergedGroupId: 'g1',
            groupName: 'Back',
            displayName: 'todos',
          }),
        ),
      ).toEqual({ group: null, name: 'Back' });
    });

    it('says «Todo» for everything', () => {
      expect(crumbsFor(source({ mergedIsAll: true }))).toEqual({
        group: null,
        name: 'Todo',
      });
    });
  });

  describe('runPillFor', () => {
    const now = 1_000_000;

    it('is green and ticks while running', () => {
      expect(
        runPillFor(item({ status: 'running', startedAt: now - 65_000 }), now),
      ).toMatchObject({ tone: 'running', text: 'En marcha · 1m 5s' });
    });

    it('says it is starting before the clock means anything', () => {
      expect(
        runPillFor(item({ status: 'starting', startedAt: now }), now).text,
      ).toBe('Arrancando');
    });

    it('is grey when stopped, with the last run in its tooltip', () => {
      expect(
        runPillFor(
          item({ status: 'stopped', startedAt: 1000, lastFinishedAt: 4000 }),
          now,
        ),
      ).toEqual({
        tone: 'stopped',
        text: 'Parado',
        title: 'Última ejecución: 3s',
      });
    });

    it('is red when the run ended in an error', () => {
      expect(runPillFor(item({ status: 'error' }), now)).toMatchObject({
        tone: 'error',
        text: 'Con errores',
      });
    });

    it('names the in-between and finished states', () => {
      expect(runPillFor(item({ status: 'stopping' }), now).text).toBe(
        'Parando',
      );
      expect(runPillFor(item({ status: 'done' }), now).text).toBe('Terminado');
    });
  });

  describe('tallyLevels', () => {
    it('counts warnings and errors, silenced ones included', () => {
      expect(
        tallyLevels([
          line({ level: 'warn' }),
          line({ level: null, originalLevel: 'warn', silenced: true }),
          line({ level: 'error' }),
          line(),
        ]),
      ).toEqual({ warn: 2, error: 1 });
    });

    it('adds one line at a time the same way', () => {
      const tally = tallyLevels([]);
      addToTally(tally, line({ level: 'error' }));
      addToTally(tally, line());
      expect(tally).toEqual({ warn: 0, error: 1 });
    });
  });
});
