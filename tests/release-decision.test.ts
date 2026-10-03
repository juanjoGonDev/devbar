import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  decideRelease,
  main,
  type ReleaseDecisionInput,
} from '../scripts/release-decision.ts';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const base: ReleaseDecisionInput = {
  currentVersion: '1.3.0',
  latestPublishedVersion: '1.2.9',
  releaseState: 'none',
  existingTagSha: null,
  headSha: HEAD,
  event: 'push',
  pendingImpact: 'true',
};

const decide = (overrides: Partial<ReleaseDecisionInput> = {}) =>
  decideRelease({ ...base, ...overrides });

describe('scripts/release-decision.ts', () => {
  describe('compareVersions', () => {
    it.each([
      ['1.2.3', '1.2.3', 0],
      ['1.2.10', '1.2.9', 1],
      ['1.10.0', '1.9.9', 1],
      ['2.0.0', '10.0.0', -1],
      ['0.9.8', '0.10.0', -1],
    ])('orders %s against %s numerically', (a, b, sign) => {
      expect(Math.sign(compareVersions(a, b))).toBe(sign);
    });

    it('rejects versions that are not stable semver', () => {
      expect(() => compareVersions('1.2.3-rc.1', '1.2.3')).toThrow(
        'Not a stable semantic version: 1.2.3-rc.1',
      );
    });
  });

  describe('decideRelease', () => {
    it('publishes an unreleased version newer than the latest release', () => {
      expect(decide()).toEqual({
        action: 'publish',
        reason: `Publishing v1.3.0 from ${HEAD}.`,
        deleteDrafts: false,
        deleteTag: false,
        tagAtHead: false,
      });
    });

    it('publishes the first release when there is no published baseline', () => {
      expect(
        decide({ latestPublishedVersion: null, pendingImpact: 'unknown' })
          .action,
      ).toBe('publish');
    });

    it('never touches a published release, whatever the tag says', () => {
      for (const existingTagSha of [null, HEAD, OLD]) {
        const decision = decide({ releaseState: 'published', existingTagSha });
        expect(decision.action).toBe('skip');
        expect(decision.deleteDrafts).toBe(false);
        expect(decision.deleteTag).toBe(false);
      }
    });

    it('skips a push without release-impacting commits since the latest release', () => {
      const decision = decide({ pendingImpact: 'false' });
      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('No release-impacting commits');
    });

    it('lets workflow_dispatch recover regardless of pending impact', () => {
      expect(
        decide({ event: 'workflow_dispatch', pendingImpact: 'false' }).action,
      ).toBe('publish');
    });

    it('fails when package.json goes backwards against the latest release', () => {
      const decision = decide({ currentVersion: '1.2.0' });
      expect(decision.action).toBe('fail');
      expect(decision.reason).toContain('lower than the latest published');
    });

    it('fails when the latest release equals the version yet is not resolvable by tag', () => {
      expect(decide({ currentVersion: '1.2.9' }).action).toBe('fail');
    });

    it('heals a leftover draft from a cancelled run', () => {
      expect(decide({ releaseState: 'draft' })).toMatchObject({
        action: 'heal',
        deleteDrafts: true,
        deleteTag: false,
      });
    });

    it('heals an unpublished tag that points away from HEAD', () => {
      expect(decide({ existingTagSha: OLD })).toMatchObject({
        action: 'heal',
        deleteDrafts: false,
        deleteTag: true,
        tagAtHead: false,
      });
    });

    it('heals a draft and a stale tag together', () => {
      expect(
        decide({ releaseState: 'draft', existingTagSha: OLD }),
      ).toMatchObject({ action: 'heal', deleteDrafts: true, deleteTag: true });
    });

    it('keeps an unpublished tag that already points to HEAD', () => {
      expect(decide({ existingTagSha: HEAD })).toMatchObject({
        action: 'publish',
        deleteTag: false,
        tagAtHead: true,
      });
    });

    it.each([
      [{ currentVersion: '1.3' }, 'not a stable semantic version'],
      [{ currentVersion: 'v1.3.0' }, 'not a stable semantic version'],
      [{ latestPublishedVersion: '1.2' }, 'not a stable semantic version'],
      [{ headSha: 'abc123' }, 'not a full commit SHA'],
      [{ existingTagSha: 'main' }, 'not a full commit SHA'],
    ])('fails on malformed input %o', (overrides, message) => {
      const decision = decide(overrides);
      expect(decision.action).toBe('fail');
      expect(decision.reason).toContain(message);
    });
  });

  describe('main', () => {
    const args = [
      '--current',
      '1.3.0',
      '--latest',
      '1.2.9',
      '--state',
      'draft',
      '--tag-sha',
      '',
      '--head',
      HEAD,
      '--event',
      'push',
      '--impact',
      'true',
    ];

    it('parses the workflow flags, treating empty values as absent', () => {
      expect(main(args)).toMatchObject({
        action: 'heal',
        deleteDrafts: true,
        deleteTag: false,
      });
    });

    it('rejects unknown enum values', () => {
      const bad = [...args];
      bad[5] = 'deleted';
      expect(() => main(bad)).toThrow('--state must be one of');
    });

    it('requires the current version and HEAD', () => {
      expect(() => main(['--state', 'none'])).toThrow('--current is required');
    });

    it('prints the decision as JSON when run as a script', () => {
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          resolve('scripts/release-decision.ts'),
          ...args,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ action: 'heal' });
    });
  });
});
