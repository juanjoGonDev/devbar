import { describe, it, expect } from 'vitest';
import {
  normalizeSchedule,
  normalizeCommand,
  normalizeAction,
} from '../src/groups-model.js';

describe('normalizeSchedule', () => {
  it('defaults to disabled with no rules when input is missing', () => {
    expect(normalizeSchedule(undefined)).toEqual({ enabled: false, rules: [] });
  });

  it('coerces enabled to a boolean', () => {
    expect(normalizeSchedule({ enabled: 1, rules: [] }).enabled).toBe(true);
    expect(normalizeSchedule({ enabled: 0, rules: [] }).enabled).toBe(false);
  });

  it('normalizes each rule: zero-pads time, filters + sorts days', () => {
    const s = normalizeSchedule({
      enabled: true,
      rules: [
        { time: '9:5', days: [3, 1, 1] },
        { time: '23:59', days: [] },
      ],
    });
    expect(s.rules).toEqual([
      { time: '09:05', days: [1, 3] },
      { time: '23:59', days: [] },
    ]);
  });

  it('falls back to 09:00 on garbage time and drops out-of-range days', () => {
    const s = normalizeSchedule({
      enabled: true,
      rules: [{ time: '24:00', days: [7, -1, 2.5, 'x', 2] }],
    });
    expect(s.rules).toEqual([{ time: '09:00', days: [2] }]);
  });

  it('migrates a legacy single {time,days} schedule into one rule', () => {
    expect(
      normalizeSchedule({ enabled: true, time: '8:30', days: [1, 2] }),
    ).toEqual({ enabled: true, rules: [{ time: '08:30', days: [1, 2] }] });
  });
});

describe('normalizeCommand carries schedule', () => {
  it('adds a default disabled schedule when absent', () => {
    expect(normalizeCommand({ command: 'x' }).schedule).toEqual({
      enabled: false,
      rules: [],
    });
  });

  it('preserves and normalizes multiple rules', () => {
    const cmd = normalizeCommand({
      command: 'x',
      schedule: {
        enabled: true,
        rules: [
          { time: '7:0', days: [5, 1, 1] },
          { time: '14:00', days: [] },
        ],
      },
    });
    expect(cmd.schedule).toEqual({
      enabled: true,
      rules: [
        { time: '07:00', days: [1, 5] },
        { time: '14:00', days: [] },
      ],
    });
  });
});

describe('normalizeAction carries schedule', () => {
  it('adds a default disabled schedule when absent', () => {
    expect(normalizeAction({ command: 'pnpm install' }).schedule).toEqual({
      enabled: false,
      rules: [],
    });
  });

  it('preserves a provided multi-rule schedule', () => {
    const act = normalizeAction({
      command: 'git pull',
      schedule: {
        enabled: true,
        rules: [{ time: '8:30', days: [1, 2, 3, 4, 5] }],
      },
    });
    expect(act.schedule).toEqual({
      enabled: true,
      rules: [{ time: '08:30', days: [1, 2, 3, 4, 5] }],
    });
  });
});
