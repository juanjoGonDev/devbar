import {
  generateIdentity,
  identityFromSeed,
  type Identity,
} from '../../src/main/remote/rc-protocol.js';

/**
 * A desktop identity key held in memory only: what the protocol tests sign
 * with when storing it (and the keychain, src/main/remote/identity.ts) is
 * not what they are about.
 */
export function memoryIdentity() {
  const fresh = (): Identity => identityFromSeed(generateIdentity().seed);
  let current = fresh();
  return {
    publicKey: (): Buffer => current.publicKey,
    sign: (data: Uint8Array): Buffer => current.sign(data),
    /** A brand-new key, as «Renovar clave del equipo» makes. */
    renew: (): void => {
      current = fresh();
    },
  };
}
