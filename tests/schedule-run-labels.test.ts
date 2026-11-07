import { describe, expect, it } from 'vitest';

import { runLabels } from '../renderer/schedule/run-labels.js';

// 2026-01-05 is a Monday.
const NOW = new Date(2026, 0, 5, 12, 20);

describe('renderer/schedule/run-labels.ts', () => {
  it('names today once and leaves the day off the runs that follow it', () => {
    expect(
      runLabels(
        [
          new Date(2026, 0, 5, 12, 30),
          new Date(2026, 0, 5, 12, 45),
          new Date(2026, 0, 5, 13, 0),
        ],
        NOW,
      ),
    ).toEqual(['hoy 12:30', '12:45', '13:00']);
  });

  it('says tomorrow, then the weekday within the week', () => {
    expect(
      runLabels(
        [
          new Date(2026, 0, 6, 8, 0),
          new Date(2026, 0, 7, 8, 0),
          new Date(2026, 0, 11, 8, 0),
        ],
        NOW,
      ),
    ).toEqual(['mañana 08:00', 'miércoles 08:00', 'domingo 08:00']);
  });

  it('falls back to the date a week or more away', () => {
    expect(runLabels([new Date(2026, 0, 12, 7, 5)], NOW)).toEqual([
      '12/1 07:05',
    ]);
  });

  it('is empty for no runs', () => {
    expect(runLabels([], NOW)).toEqual([]);
  });
});
