import { describe, it, expect } from 'vitest';
import { normalizeCommand, normalizeAction } from '../src/groups-model.js';

// Commands and actions share the pre-script confirmation contract:
//   confirm:false            → { confirm:false, confirmSecs:null, confirmOnTimeout:'cancel' }
//   confirm:true, no secs    → confirmSecs defaults to 60
//   confirmSecs clamps to [3,3600]; confirmOnTimeout is 'confirm' | 'cancel'
for (const [label, normalize] of [
  ['normalizeCommand', normalizeCommand],
  ['normalizeAction', normalizeAction],
]) {
  describe(`${label} confirmation gate`, () => {
    it('defaults to no confirmation', () => {
      const x = normalize({ command: 'x' });
      expect(x.confirm).toBe(false);
      expect(x.confirmSecs).toBe(null);
      expect(x.confirmOnTimeout).toBe('cancel');
    });

    it('opting in with no secs defaults the countdown to 60', () => {
      const x = normalize({ command: 'x', confirm: true });
      expect(x.confirm).toBe(true);
      expect(x.confirmSecs).toBe(60);
    });

    it('clamps confirmSecs into [3, 3600]', () => {
      expect(
        normalize({ command: 'x', confirm: true, confirmSecs: 1 }).confirmSecs,
      ).toBe(3);
      expect(
        normalize({ command: 'x', confirm: true, confirmSecs: 99999 })
          .confirmSecs,
      ).toBe(3600);
      expect(
        normalize({ command: 'x', confirm: true, confirmSecs: 30 }).confirmSecs,
      ).toBe(30);
    });

    it('treats an explicit empty/zero countdown as indefinite (null)', () => {
      expect(
        normalize({ command: 'x', confirm: true, confirmSecs: 0 }).confirmSecs,
      ).toBe(null);
      expect(
        normalize({ command: 'x', confirm: true, confirmSecs: '' }).confirmSecs,
      ).toBe(null);
    });

    it('honors confirmOnTimeout = confirm', () => {
      expect(
        normalize({ command: 'x', confirm: true, confirmOnTimeout: 'confirm' })
          .confirmOnTimeout,
      ).toBe('confirm');
    });

    it('ignores confirm settings when confirm is false', () => {
      const x = normalize({ command: 'x', confirm: false, confirmSecs: 30 });
      expect(x.confirmSecs).toBe(null);
    });

    it('canonicalizes confirmOnTimeout to cancel when confirm is false', () => {
      const x = normalize({
        command: 'x',
        confirm: false,
        confirmOnTimeout: 'confirm',
      });
      expect(x.confirmOnTimeout).toBe('cancel');
    });
  });
}
