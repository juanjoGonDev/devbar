import type { SecretBox } from '../../src/main/remote/identity.js';

/**
 * A reversible stand-in for Electron's async safeStorage — "box:" plus the
 * text reversed — that a test can turn into each keychain the app meets:
 * one that is not there (`setAvailable(false)`), one that refuses (locked,
 * or the user denied access: `setLocked(true)`), one that asks for what it
 * opened to be sealed again (`setReEncrypt(true)`), and one whose answer is
 * still pending — the macOS «quiere usar información confidencial» prompt
 * nobody has answered yet (`hold()` … `release()`).
 */
export interface FakeKeychain extends SecretBox {
  /** Every call, in order: `available`, `encrypt`, `decrypt`. */
  calls: string[];
  setAvailable(on: boolean): void;
  setLocked(on: boolean): void;
  setReEncrypt(on: boolean): void;
  /** From now on every call waits for `release()`, like an open prompt. */
  hold(): void;
  /** Answers every call that was held (as things are now) and stops holding. */
  release(): Promise<void>;
  /** How many calls are waiting for an answer. */
  pending(): number;
}

/** Lets every promise chain that can move on do so. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const reversed = (text: string): string => [...text].reverse().join('');

export function fakeKeychain(): FakeKeychain {
  const calls: string[] = [];
  let available = true;
  let locked = false;
  let reEncrypt = false;
  let holding = false;
  let waiting: (() => void)[] = [];

  /** The keychain's answer, worked out when it is given (not when asked). */
  const answer = <T>(call: string, work: () => T): Promise<T> => {
    calls.push(call);
    return new Promise<T>((resolve, reject) => {
      const give = (): void => {
        try {
          resolve(work());
        } catch (failure) {
          reject(failure instanceof Error ? failure : new Error('refused'));
        }
      };
      if (holding) waiting.push(give);
      else give();
    });
  };

  return {
    calls,
    setAvailable: (on) => {
      available = on;
    },
    setLocked: (on) => {
      locked = on;
    },
    setReEncrypt: (on) => {
      reEncrypt = on;
    },
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      const held = waiting;
      waiting = [];
      for (const give of held) give();
      await settle();
    },
    pending: () => waiting.length,
    isAsyncEncryptionAvailable: () => answer('available', () => available),
    encryptStringAsync: (plain) =>
      answer('encrypt', () => {
        if (locked) throw new Error('keychain locked');
        return Buffer.from(`box:${reversed(plain)}`);
      }),
    decryptStringAsync: (sealed) =>
      answer('decrypt', () => {
        if (locked) throw new Error('user denied access');
        const text = sealed.toString();
        if (!text.startsWith('box:')) throw new Error('not ours');
        return { shouldReEncrypt: reEncrypt, result: reversed(text.slice(4)) };
      }),
  };
}
