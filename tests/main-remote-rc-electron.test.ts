import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronBinary from 'electron';
import { describe, expect, it } from 'vitest';

/**
 * The desktop half of devbar-rc/1 runs inside Electron, whose crypto is
 * BoringSSL, not the OpenSSL of the Node that runs every other test. A
 * primitive Node has and Electron lacks (ChaCha20-Poly1305 via
 * createCipheriv) once passed the whole suite and failed every phone in the
 * real app. This runs the protocol module in Electron's own runtime.
 */

const PROTOCOL = path.join(
  import.meta.dirname,
  '..',
  'src',
  'main',
  'remote',
  'rc-protocol.ts',
);

const SCRIPT = `
import * as rc from ${JSON.stringify(PROTOCOL)};
const text = (bytes) => new TextDecoder().decode(bytes);
const id = rc.generateIdentity();
const identity = rc.identityFromSeed(id.seed);
const phone = rc.ephemeralKeyPair();
const desk = rc.ephemeralKeyPair();
const sid = new Uint8Array(16).fill(3);
const t = rc.transcript(id.publicKey, phone.publicKey, desk.publicKey, sid);
const sig = identity.sign(t);
const shared = desk.agree(phone.publicKey);
const keys = rc.sessionKeys(shared, t);
const aad = rc.aad('c2s-rpc', 'sid');
const sealed = rc.seal(keys.c2s, 1, aad, new TextEncoder().encode('hola'));
console.log(JSON.stringify({
  signed: rc.verifySignature(id.publicKey, t, sig),
  opened: text(rc.open(keys.c2s, 1, aad, sealed) ?? new Uint8Array()),
  event: typeof rc.sealEvent(keys.s2c, 2, aad, new Uint8Array([1])),
}));
`;

describe('src/main/remote/rc-protocol.ts under Electron', () => {
  it('handshakes, signs and seals with the crypto Electron ships', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-rc-electron-'));
    const file = path.join(dir, 'probe.mts');
    fs.writeFileSync(file, SCRIPT);
    try {
      const out = execFileSync(
        electronBinary as unknown as string,
        ['--experimental-strip-types', '--no-warnings', file],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
        },
      );
      expect(JSON.parse(out.trim().split('\n').at(-1) ?? '{}')).toEqual({
        signed: true,
        opened: 'hola',
        event: 'string',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
