import { createRemoteClient, type Me } from './api.js';
import type { RemoteEnv } from './env.js';
import { fillGlyphs } from './glyphs.js';
import { startPanel, type Panel } from './panel.js';
import { byId, showView } from './view.js';

export type { RemoteEnv } from './env.js';

/**
 * The phone page's flow. It decides its view from /api/me alone:
 *
 *   linked                → the control panel (renderer/remote/panel.ts);
 *   not linked, ?c=<code> → the pairing form, then the verification code
 *                           while the computer decides;
 *   not linked            → how to link it from the computer.
 *
 * The browser's globals arrive as `RemoteEnv` (renderer/remote.ts), so every
 * step can be driven from a test.
 */

const POLL_MS = 1000;
/** Consecutive failed polls before the page stops and says so. */
const MAX_POLL_FAILURES = 5;
const NAME_HINT = 'Ponle un nombre de 1 a 40 caracteres.';
const UNREACHABLE = 'No se pudo conectar con DevBar. Inténtalo de nuevo.';

function elements() {
  return {
    expiredNote: byId<HTMLElement>('expired-note', HTMLElement),
    pairTitle: byId<HTMLElement>('pair-title', HTMLElement),
    pairForm: byId<HTMLFormElement>('pair-form', HTMLFormElement),
    deviceName: byId<HTMLInputElement>('device-name', HTMLInputElement),
    pairError: byId<HTMLElement>('pair-error', HTMLElement),
    pairSubmit: byId<HTMLButtonElement>('pair-submit', HTMLButtonElement),
    verificationCode: byId<HTMLElement>('verification-code', HTMLElement),
    pairCancel: byId<HTMLButtonElement>('pair-cancel', HTMLButtonElement),
    resultTitle: byId<HTMLElement>('result-title', HTMLElement),
    resultText: byId<HTMLElement>('result-text', HTMLElement),
    resultDone: byId<HTMLButtonElement>('result-done', HTMLButtonElement),
    retry: byId<HTMLButtonElement>('retry', HTMLButtonElement),
  };
}

export async function startRemoteApp(env: RemoteEnv): Promise<void> {
  const els = elements();
  fillGlyphs(document);
  const client = createRemoteClient(env.fetch);
  const code = new URLSearchParams(env.search).get('c');
  /** Bumped to abandon a poll loop (cancel, a new view). */
  let pollRound = 0;
  let pollTimer: unknown = null;
  /** The request the phone is waiting on, to withdraw on «Cancelar». */
  let waitingOn: string | null = null;
  let panel: Panel | null = null;

  const stopPolling = (): void => {
    pollRound += 1;
    if (pollTimer !== null) env.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const showUnlinked = (fromStaleCode: boolean): void => {
    stopPolling();
    waitingOn = null;
    panel?.stop();
    els.expiredNote.classList.toggle('is-emphasised', fromStaleCode);
    showView('unlinked');
  };

  const showResult = (title: string, body: string): void => {
    stopPolling();
    els.resultTitle.textContent = title;
    els.resultText.textContent = body;
    showView('result');
  };

  const showLinked = (me: Me): void => {
    // The panel wires listeners on the page itself: one per page load. Any
    // later "linked" (a retry) starts from a fresh page instead.
    if (panel) {
      env.reload();
      return;
    }
    showView('linked');
    panel = startPanel({
      env,
      client,
      me,
      onUnlinked: () => showUnlinked(false),
    });
  };

  const showPairForm = (me: Me): void => {
    els.pairTitle.textContent = `Vincular con ${me.hostName}`;
    els.deviceName.value = me.suggestedName;
    els.pairError.hidden = true;
    showView('pair');
  };

  async function boot(): Promise<void> {
    stopPolling();
    showView('loading');
    let me: Me;
    try {
      me = await client.me();
    } catch {
      showView('error');
      return;
    }
    if (me.linked) showLinked(me);
    else if (code) showPairForm(me);
    else showUnlinked(false);
  }

  function poll(requestId: string, round: number, failures: number): void {
    pollTimer = env.setTimeout(() => {
      void (async () => {
        let answer;
        try {
          answer = await client.pairStatus(requestId);
        } catch {
          if (round !== pollRound) return;
          if (failures + 1 >= MAX_POLL_FAILURES) {
            stopPolling();
            showView('error');
          } else poll(requestId, round, failures + 1);
          return;
        }
        if (round !== pollRound) return;
        const status = answer.status === 200 ? answer.body.status : 'expired';
        if (status === 'pending') poll(requestId, round, 0);
        else if (status === 'accepted') void boot();
        else if (status === 'rejected')
          showResult(
            'Vinculación rechazada',
            'El ordenador ha rechazado este dispositivo. Si eras tú, genera un código nuevo en DevBar y vuelve a escanearlo.',
          );
        else
          showResult(
            'La solicitud ha caducado',
            'Nadie la aceptó a tiempo en el ordenador. Genera un código nuevo en DevBar y vuelve a escanearlo.',
          );
      })();
    }, POLL_MS);
  }

  const formError = (message: string): void => {
    els.pairError.textContent = message;
    els.pairError.hidden = false;
  };

  els.pairForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = els.deviceName.value.trim();
    if (!code) return;
    if (!name || name.length > 40) {
      formError(NAME_HINT);
      return;
    }
    els.pairSubmit.disabled = true;
    els.pairError.hidden = true;
    void (async () => {
      try {
        const answer = await client.requestPairing(code, name);
        if (answer.status === 200) {
          env.replaceUrl('/');
          const digits = String(answer.body.verificationCode ?? '');
          els.verificationCode.textContent = `${digits.slice(0, 3)} ${digits.slice(3)}`;
          showView('waiting');
          stopPolling();
          waitingOn = String(answer.body.requestId ?? '');
          poll(waitingOn, pollRound, 0);
        } else if (answer.status === 410) {
          env.replaceUrl('/');
          showUnlinked(true);
        } else if (answer.status === 429)
          formError('Demasiados intentos. Espera un minuto y vuelve a probar.');
        else if (answer.status === 400) formError(NAME_HINT);
        else formError(UNREACHABLE);
      } catch {
        formError(UNREACHABLE);
      } finally {
        els.pairSubmit.disabled = false;
      }
    })();
  });

  els.pairCancel.addEventListener('click', () => {
    const requestId = waitingOn;
    showUnlinked(false);
    // Best effort: the computer closes its dialog right away instead of
    // waiting out the minute. Nothing changes here if it never arrives.
    if (requestId) void client.cancelPairing(requestId).catch(() => undefined);
  });
  els.resultDone.addEventListener('click', () => showUnlinked(false));
  els.retry.addEventListener('click', () => void boot());

  await boot();
}
