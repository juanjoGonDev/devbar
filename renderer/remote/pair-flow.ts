import type { Answer, Me, RemoteClient } from './api.js';
import { RemoteError } from './channel.js';
import { LOST } from './context.js';
import type { RemoteEnv } from './env.js';
import { storageWorks, type DeviceKeys } from './keys.js';
import { generateSigningKey, toB64 } from './rc-protocol.js';
import { showView } from './view.js';

/**
 * Pairing from the QR (`/pair#c=<code>&k=<identity key>`): the page trusts
 * the key that came in the fragment — straight from the computer's screen —
 * and shakes hands only with a DevBar that proves it holds it. It claims the
 * code at once (it only lasts 30 seconds; the claim leaves this session two
 * minutes), then the form (this device's name), a fresh Ed25519 key pair for
 * the device (which signs the handshake to prove it is held), the 6-digit
 * code the user types on the computer to accept it, and — once accepted —
 * the keys to keep.
 */

const POLL_MS = 1000;
/** Consecutive failed polls before the page stops and says so. */
const MAX_POLL_FAILURES = 5;
const NAME_HINT = 'Ponle un nombre de 1 a 40 caracteres.';
const UNREACHABLE = 'No se pudo conectar con DevBar. Inténtalo de nuevo.';
const CLAIM_EXPIRED = 'El código ha caducado, escanea uno nuevo.';
const NO_STORAGE =
  'Este navegador no deja guardar datos de esta página. Ábrela fuera del modo privado.';

interface PairElements {
  pairTitle: HTMLElement;
  pairForm: HTMLFormElement;
  deviceName: HTMLInputElement;
  pairError: HTMLElement;
  pairSubmit: HTMLButtonElement;
  verificationCode: HTMLElement;
  pairCancel: HTMLButtonElement;
}

export interface PairFlowDeps {
  env: RemoteEnv;
  client: RemoteClient;
  els: PairElements;
  /** Accepted on the computer: the keys this device keeps from now on. */
  linked(keys: DeviceKeys): void;
  showUnlinked(fromStaleCode: boolean): void;
  showResult(title: string, body: string): void;
}

export interface PairFlow {
  start(code: string, serverKey: Uint8Array): Promise<void>;
  /** Abandons the form and any poll. */
  stop(): void;
}

export function createPairFlow(deps: PairFlowDeps): PairFlow {
  const { env, client, els } = deps;
  let pairing: { serverKey: Uint8Array; me: Me } | null = null;
  /** Bumped to abandon a poll loop (cancel, a new view). */
  let pollRound = 0;
  let pollTimer: unknown = null;
  /** The request the phone is waiting on, to withdraw on «Cancelar». */
  let waitingOn: string | null = null;

  const stop = (): void => {
    pollRound += 1;
    if (pollTimer !== null) env.clearTimeout(pollTimer);
    pollTimer = null;
    waitingOn = null;
  };

  const formError = (message: string): void => {
    els.pairError.textContent = message;
    els.pairError.hidden = false;
  };

  function settled(status: unknown): void {
    stop();
    if (status === 'rejected')
      deps.showResult(
        'Vinculación rechazada',
        'El ordenador ha rechazado este dispositivo. Si eras tú, genera un código nuevo en DevBar y vuelve a escanearlo.',
      );
    else
      deps.showResult(
        'La solicitud ha caducado',
        'Nadie la aceptó a tiempo en el ordenador. Genera un código nuevo en DevBar y vuelve a escanearlo.',
      );
  }

  function poll(
    requestId: string,
    device: { secretKey: Uint8Array; publicKey: Uint8Array },
    round: number,
    failures: number,
  ): void {
    pollTimer = env.setTimeout(() => {
      void (async () => {
        let answer;
        try {
          answer = await client.pairStatus(requestId);
        } catch {
          if (round !== pollRound) return;
          if (failures + 1 >= MAX_POLL_FAILURES) {
            stop();
            showView('error');
          } else poll(requestId, device, round, failures + 1);
          return;
        }
        if (round !== pollRound || !pairing) return;
        const status = answer.status === 200 ? answer.body.status : 'expired';
        const deviceId = answer.body.deviceId;
        if (status === 'pending') poll(requestId, device, round, 0);
        else if (status === 'accepted' && typeof deviceId === 'string') {
          stop();
          deps.linked({
            serverIdPub: toB64(pairing.serverKey),
            deviceId,
            devicePriv: toB64(device.secretKey),
            devicePub: toB64(device.publicKey),
            verified: false,
            hostName: pairing.me.hostName,
          });
        } else settled(status);
      })();
    }, POLL_MS);
  }

  async function submit(): Promise<void> {
    const name = els.deviceName.value.trim();
    if (!pairing) return;
    if (!name || name.length > 40) return formError(NAME_HINT);
    if (!storageWorks(env)) return formError(NO_STORAGE);
    els.pairSubmit.disabled = true;
    els.pairError.hidden = true;
    const device = generateSigningKey();
    try {
      const answer = await client.requestPairing(name, device);
      if (answer.status === 200) {
        env.replaceUrl('/');
        const digits = String(answer.body.verificationCode ?? '');
        els.verificationCode.textContent = `${digits.slice(0, 3)} ${digits.slice(3)}`;
        showView('waiting');
        stop();
        waitingOn = String(answer.body.requestId ?? '');
        poll(waitingOn, device, pollRound, 0);
      } else if (answer.status === 410) formError(CLAIM_EXPIRED);
      else if (answer.status === 429)
        formError('Demasiados intentos. Espera un minuto y vuelve a probar.');
      else if (answer.status === 400) formError(NAME_HINT);
      else formError(UNREACHABLE);
    } catch (error) {
      const lost = error instanceof RemoteError && error.code === 'session';
      formError(lost ? LOST : UNREACHABLE);
    } finally {
      els.pairSubmit.disabled = false;
    }
  }

  els.pairForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  els.pairCancel.addEventListener('click', () => {
    const requestId = waitingOn;
    stop();
    deps.showUnlinked(false);
    // Best effort: the computer closes its dialog right away instead of
    // waiting out the minute. Nothing changes here if it never arrives.
    if (requestId) void client.cancelPairing(requestId).catch(() => undefined);
  });

  return {
    start: async (code, serverKey) => {
      stop();
      showView('loading');
      client.trust({ serverKey, device: null });
      let me: Me;
      let claim: Answer;
      try {
        await client.reconnect();
        me = await client.me();
        claim = await client.claimPairing(code);
      } catch (error) {
        if (error instanceof RemoteError && error.code === 'changed')
          deps.showResult(
            'No se pudo verificar el ordenador',
            'Este código QR no corresponde al DevBar que responde en esta dirección. Genera uno nuevo en el ordenador y vuelve a escanearlo.',
          );
        else showView('error');
        return;
      }
      if (claim.status === 410) return deps.showUnlinked(true);
      if (claim.status === 429)
        return deps.showResult(
          'Demasiados intentos',
          'Espera un minuto y vuelve a escanear el código.',
        );
      if (claim.status !== 200) return showView('error');
      pairing = { serverKey, me };
      els.pairTitle.textContent = `Vincular con ${me.hostName}`;
      els.deviceName.value = me.suggestedName;
      els.pairError.hidden = true;
      showView('pair');
    },
    stop,
  };
}
