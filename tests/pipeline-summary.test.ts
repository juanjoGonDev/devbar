import { describe, expect, it } from 'vitest';
import { summarizePipeline } from '../renderer/pipeline-editor.js';
import type { PreStep } from '../src/domain-types.js';

// Mirrors the user-approved UI prototype (`arranque-prototipo.html`): the
// summary strip must render one block per step, with a muted header line and
// one lane per script — not the bare coloured-dot boxes it regressed to.
// Kept as a pure function so it can be driven from plain fixtures without a
// DOM, following the `tests/tooltip.test.ts` precedent.

const SCRIPT_NAMES: Record<string, Record<string, string>> = {
  infra: { vpn: 'Túnel VPN' },
  back: { db: 'Levantar DB', migrate: 'Migraciones' },
};
const GROUP_NAMES: Record<string, string> = { infra: 'Infra', back: 'Backend' };

function resolve(
  groupId: string,
  scriptId: string,
): { groupName: string; scriptName: string } | null {
  const scriptName = SCRIPT_NAMES[groupId]?.[scriptId];
  if (!scriptName) return null;
  return { groupName: GROUP_NAMES[groupId] ?? groupId, scriptName };
}

function step(mode: PreStep['mode'], scripts: PreStep['scripts']): PreStep {
  return { id: `s-${mode}-${scripts.length}`, mode, scripts };
}

describe('summarizePipeline', () => {
  it('summarizes a single-script step without a parallel/serial marker', () => {
    const [result] = summarizePipeline(
      [step('serial', [{ groupId: 'infra', scriptId: 'vpn' }])],
      resolve,
    );
    expect(result.index).toBe(1);
    expect(result.mode).toBe('serial');
    expect(result.isParallel).toBe(false);
    expect(result.isEmpty).toBe(false);
    expect(result.lanes).toEqual([
      { groupName: 'Infra', scriptName: 'Túnel VPN', broken: false },
    ]);
  });

  it('flags a multi-script parallel step as highlighted parallel', () => {
    const [result] = summarizePipeline(
      [
        step('parallel', [
          { groupId: 'back', scriptId: 'db' },
          { groupId: 'infra', scriptId: 'vpn' },
        ]),
      ],
      resolve,
    );
    expect(result.mode).toBe('parallel');
    expect(result.isParallel).toBe(true);
    expect(result.lanes).toEqual([
      { groupName: 'Backend', scriptName: 'Levantar DB', broken: false },
      { groupName: 'Infra', scriptName: 'Túnel VPN', broken: false },
    ]);
  });

  it('does not flag a multi-script serial step as parallel', () => {
    const [result] = summarizePipeline(
      [
        step('serial', [
          { groupId: 'back', scriptId: 'db' },
          { groupId: 'back', scriptId: 'migrate' },
        ]),
      ],
      resolve,
    );
    expect(result.mode).toBe('serial');
    expect(result.isParallel).toBe(false);
    expect(result.lanes).toHaveLength(2);
    expect(result.lanes[1]).toEqual({
      groupName: 'Backend',
      scriptName: 'Migraciones',
      broken: false,
    });
  });

  it('marks a step with zero scripts as empty, with no lanes', () => {
    const [result] = summarizePipeline([step('parallel', [])], resolve);
    expect(result.isEmpty).toBe(true);
    expect(result.isParallel).toBe(false);
    expect(result.lanes).toEqual([]);
  });

  it('marks an unresolvable ref as a broken lane instead of throwing', () => {
    const [result] = summarizePipeline(
      [step('serial', [{ groupId: 'ghost', scriptId: 'gone' }])],
      resolve,
    );
    expect(result.isEmpty).toBe(false);
    expect(result.lanes).toEqual([
      { groupName: '', scriptName: '', broken: true },
    ]);
  });

  it('numbers steps starting at 1 and preserves pipeline order', () => {
    const result = summarizePipeline(
      [
        step('serial', [{ groupId: 'infra', scriptId: 'vpn' }]),
        step('parallel', []),
      ],
      resolve,
    );
    expect(result.map((s) => s.index)).toEqual([1, 2]);
    expect(result.map((s) => s.isEmpty)).toEqual([false, true]);
  });
});
