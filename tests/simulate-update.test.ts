import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/dev/simulate-update.ts` builds an update that is real in every way that
 * matters: a genuine copy of the running bundle with its version bumped and
 * its seal remade, so the production staging path verifies it, unpacks it and
 * swaps it in exactly as it would a GitHub release.
 *
 * The macOS tools it drives are replaced here by stand-ins that do the minimum
 * real work (`ditto` really copies), so everything the module itself decides —
 * the order, what gets patched, what gets signed, and what is cleaned up — runs
 * for real against real files, on any OS.
 */
interface ExecCall {
  file: string;
  args: string[];
}

const calls: ExecCall[] = [];
/** Keys `PlistBuddy -c "Print …"` will answer for; anything else "fails". */
let plistKeys: Set<string>;
/** Commands whose stand-in should fail, by the first argument they carry. */
let failing: Set<string>;
/** Runs just before the bundle is signed, while the staged copy still exists. */
let onCodesign: (appPath: string) => void;

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    callback: (
      error: Error | null,
      result: { stdout: string; stderr: string },
    ) => void,
  ) => {
    calls.push({ file, args });
    const done = (error: Error | null): void =>
      void setTimeout(() => callback(error, { stdout: '', stderr: '' }), 0);
    if (failing.has(args[0] ?? '')) {
      done(new Error(`falló: ${args[0]}`));
      return;
    }
    if (file.endsWith('ditto')) {
      if (args[0] === '-c') {
        // `ditto -c -k --keepParent <app> <zip>` — a stand-in archive is enough.
        fs.writeFileSync(String(args[4]), 'zip');
      } else {
        fs.cpSync(String(args[0]), String(args[1]), { recursive: true });
      }
      done(null);
      return;
    }
    if (file.endsWith('PlistBuddy')) {
      const command = String(args[1] ?? '');
      const key = command.replace(/^(Print|Set) /u, '').split(' ')[0] ?? '';
      if (command.startsWith('Print') && !plistKeys.has(key)) {
        done(new Error('Print: Entry, Does Not Exist'));
        return;
      }
      done(null);
      return;
    }
    if (file.endsWith('codesign')) onCodesign(String(args[3]));
    done(null);
  },
}));

const INTEGRITY_KEY = ':ElectronAsarIntegrity:Resources/app.asar:hash';

/** A minimal but genuine asar holding one pretty-printed package.json. */
function writeAsar(target: string, version: string): void {
  const content = JSON.stringify(
    { name: 'devbar', version, main: 'main.js' },
    null,
    2,
  );
  const header = JSON.stringify({
    files: {
      'package.json': { size: Buffer.byteLength(content), offset: '0' },
    },
  });
  const headerLength = Buffer.byteLength(header);
  const padded = Math.ceil(headerLength / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(padded + 8, 4);
  prefix.writeUInt32LE(padded + 4, 8);
  prefix.writeUInt32LE(headerLength, 12);
  const headerBuf = Buffer.alloc(padded);
  headerBuf.write(header, 0, 'utf8');
  fs.writeFileSync(
    target,
    Buffer.concat([prefix, headerBuf, Buffer.from(content, 'utf8')]),
  );
}

function plistSets(): string[] {
  return calls
    .filter((call) => call.file.endsWith('PlistBuddy'))
    .map((call) => String(call.args[1] ?? ''))
    .filter((command) => command.startsWith('Set '));
}

describe('src/dev/simulate-update.ts', () => {
  let work: string;
  let bundle: string;
  let buildSimulatedUpdate: typeof import('../src/dev/simulate-update.js').buildSimulatedUpdate;

  beforeEach(async () => {
    calls.length = 0;
    plistKeys = new Set([
      'CFBundleShortVersionString',
      'CFBundleVersion',
      INTEGRITY_KEY,
    ]);
    failing = new Set();
    onCodesign = () => undefined;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-sim-'));
    bundle = path.join(work, 'DevBar.app');
    fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<plist/>');
    writeAsar(path.join(bundle, 'Contents', 'Resources', 'app.asar'), '1.0.0');
    ({ buildSimulatedUpdate } = await import('../src/dev/simulate-update.js'));
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function build(version = '1.1.0'): Promise<string> {
    return buildSimulatedUpdate({ bundlePath: bundle, workDir: work, version });
  }

  describe('buildSimulatedUpdate', () => {
    it('hands back the archive staging will consume', async () => {
      const zip = await build('1.1.0');
      expect(zip).toBe(path.join(work, 'DevBar-1.1.0-sim.zip'));
      expect(fs.existsSync(zip)).toBe(true);
    });

    it('copies the bundle we are running rather than building a new one', async () => {
      await build();
      const ditto = calls.find((call) => call.file.endsWith('ditto'));
      expect(ditto?.args[0]).toBe(bundle);
      expect(ditto?.args[1]).toBe(path.join(work, 'sim-1.1.0', 'DevBar.app'));
    });

    it('moves both version keys the bundle advertises', async () => {
      await build('2.3.4');
      expect(plistSets()).toContain('Set :CFBundleShortVersionString 2.3.4');
      expect(plistSets()).toContain('Set :CFBundleVersion 2.3.4');
    });

    it('moves the version the app actually reads for itself', async () => {
      // Info.plist is not where `app.getVersion()` looks: that is the
      // package.json inside app.asar. Editing only the plist produces a bundle
      // that installs cleanly and still calls itself the old version.
      let staged = '';
      onCodesign = (appPath) => {
        staged = fs
          .readFileSync(
            path.join(appPath, 'Contents', 'Resources', 'app.asar'),
            'utf8',
          )
          .toString();
      };
      await build('2.3.4');
      expect(staged).toContain('"version":"2.3.4"');
      expect(staged).not.toContain('"version": "1.0.0"');
    });

    it("keeps the bundle's own claim about the archive true", async () => {
      // A build whose ElectronAsarIntegrity no longer matches refuses to start.
      let headerHash = '';
      onCodesign = (appPath) => {
        const file = fs.readFileSync(
          path.join(appPath, 'Contents', 'Resources', 'app.asar'),
        );
        headerHash = createHash('sha256')
          .update(file.subarray(16, 16 + file.readUInt32LE(12)))
          .digest('hex');
      };
      await build();
      expect(plistSets()).toContain(`Set ${INTEGRITY_KEY} ${headerHash}`);
    });

    it('claims nothing for a bundle that was built without the key', async () => {
      plistKeys.delete(INTEGRITY_KEY);
      await build();
      expect(
        plistSets().filter((command) => command.includes(INTEGRITY_KEY)),
      ).toEqual([]);
    });

    it('re-signs the OUTER bundle only', async () => {
      // --deep would restamp every nested helper with the parent's identifier,
      // and macOS keys notification permission on exactly that identifier: the
      // swapped app would come back mute.
      await build();
      const codesign = calls.find((call) => call.file.endsWith('codesign'));
      expect(codesign?.args).toEqual([
        '--force',
        '--sign',
        '-',
        path.join(work, 'sim-1.1.0', 'DevBar.app'),
      ]);
    });

    it('patches and reseals BEFORE it signs', async () => {
      await build();
      const order = calls.map((call) => path.basename(call.file));
      expect(order.lastIndexOf('PlistBuddy')).toBeLessThan(
        order.indexOf('codesign'),
      );
    });

    it('takes the loose 200 MB copy back down afterwards', async () => {
      await build();
      expect(fs.existsSync(path.join(work, 'sim-1.1.0'))).toBe(false);
    });

    it('takes it down even when the build failed halfway', async () => {
      failing.add('-c'); // the zip step
      await expect(build()).rejects.toThrow('falló: -c');
      expect(fs.existsSync(path.join(work, 'sim-1.1.0'))).toBe(false);
    });

    it('starts from an empty stage, whatever an earlier run left behind', async () => {
      const stale = path.join(work, 'sim-1.1.0', 'basura');
      fs.mkdirSync(stale, { recursive: true });
      let survived = true;
      onCodesign = () => {
        survived = fs.existsSync(stale);
      };
      await build();
      expect(survived).toBe(false);
    });

    it('replaces an archive of the same name instead of failing on it', async () => {
      const zip = path.join(work, 'DevBar-1.1.0-sim.zip');
      fs.writeFileSync(zip, 'lo de antes');
      await build();
      expect(fs.readFileSync(zip, 'utf8')).toBe('zip');
    });
  });
});
