import type { RemoteStateView } from '../../src/ipc-contract/remote-wire.js';
import type { Me, RemoteClient } from './api.js';
import { RemoteError } from './channel.js';
import { createConfirmDialog } from './confirm-dialog.js';
import { createConnection, type Verdict } from './connection.js';
import type {
  ConfirmAnswer,
  DeviceIdentity,
  PanelContext,
  TabName,
} from './context.js';
import { attempt, LOST, signedOut } from './context.js';
import { panelElements } from './elements.js';
import type { RemoteEnv } from './env.js';
import { createGroupsTab } from './groups-tab.js';
import { createLogsTab } from './logs-tab.js';
import { createNoticesTab } from './notices-tab.js';
import { createSettingsTab } from './settings-tab.js';
import {
  confirmsView,
  logBatch,
  noticeView,
  stateView,
  updateView,
} from './wire.js';

/**
 * The linked panel: four tabs over one live connection. It keeps the last
 * state DevBar pushed, measures how far this phone's clock is from the
 * computer's (countdowns and uptimes are counted on main's clock), runs the
 * 1 s clock the countdowns tick on, and routes each event of the stream to
 * the part of the page it changes.
 *
 * Nothing here decides the device is unlinked: an answer or an event that
 * says so only triggers a fresh sign-in (`recheck`), and the app forgets the
 * keys when — and only when — that sign-in is refused for an unknown device.
 */

const TOAST_MS = 4000;
const TABS: readonly TabName[] = ['groups', 'logs', 'notices', 'settings'];

export interface PanelDeps {
  env: RemoteEnv;
  client: RemoteClient;
  me: Me;
  identity: DeviceIdentity;
}

export interface Panel {
  stop(): void;
}

export function startPanel(deps: PanelDeps): Panel {
  const { env, client, me } = deps;
  const els = panelElements();
  let current: RemoteStateView | null = null;
  let skew = 0;
  let tab: TabName = 'groups';
  let live = false;
  let everLive = false;
  let readFailed = false;
  let stopped = false;
  let toastTimer: unknown = null;
  const tickers = new Map<string, (() => void)[]>();

  const toast = (message: string): void => {
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (toastTimer !== null) env.clearTimeout(toastTimer);
    toastTimer = env.setTimeout(() => {
      toastTimer = null;
      els.toast.hidden = true;
    }, TOAST_MS);
  };

  /**
   * A fresh sign-in, beside the session in use: refused for an unknown
   * device, the app takes over (onLost) and stops this panel. True while
   * the device is still linked.
   */
  const recheck = (): Promise<boolean> => client.confirmLinked();

  /** The stream or `me` said unlinked: confirm it, or start over. */
  const toldUnlinked = (): void => {
    void recheck().then(() => {
      if (!stopped) env.reload();
    });
  };

  /** A fresh handshake, then who we are now. */
  const check = async (): Promise<Verdict> => {
    try {
      await client.reconnect();
    } catch (error) {
      // A changed key or an unknown device: the client told the app already.
      if (
        error instanceof RemoteError &&
        ['changed', 'unlinked'].includes(error.code)
      )
        return 'lost';
      throw error;
    }
    const fresh = await client.me();
    if (!fresh.linked) return 'unlinked';
    return fresh.version === me.version ? 'linked' : 'reload';
  };

  const ctx: PanelContext = {
    env,
    client,
    identity: deps.identity,
    serverNow: () => env.now() + skew,
    hostName: () => current?.host.name || me.hostName,
    state: () => current,
    toast,
    showTab: (next) => showTab(next),
    openLogs: (processId) => {
      logs.prefer(processId);
      showTab('logs');
    },
    openConfirm: (token) => confirm.open(token),
    run: async (op, body = {}, options = {}) => {
      const { answer, failure } = await attempt(client.call(op, body));
      if (!answer) toast(failure);
      else if (signedOut(answer)) {
        if (await recheck()) toast(LOST);
      } else if (answer.status === 202) {
        if (options.pending) toast(options.pending);
      } else if (answer.status === 404) toast('Ya no existe en DevBar.');
      else if (answer.status !== 200) toast('DevBar no pudo hacerlo.');
      else if (answer.body.ok === false) {
        const error = answer.body.error;
        toast(
          typeof error === 'string' && error
            ? error
            : 'DevBar no pudo hacerlo.',
        );
      }
      return answer;
    },
    answerConfirm: async (token, decision): Promise<ConfirmAnswer> => {
      const { answer, failure } = await attempt(
        client.call('confirm', { token, decision }),
      );
      if (answer?.status === 200) return 'ok';
      if (answer?.status === 409) return 'gone';
      if (signedOut(answer)) {
        if (await recheck()) toast(LOST);
      } else toast(answer ? 'No se pudo responder.' : failure);
      return 'error';
    },
    onTick: (owner, fns) => tickers.set(owner, fns),
    recheck,
  };

  const groups = createGroupsTab(els.groups, els.branches, ctx, me.version);
  const logs = createLogsTab(els.logs, ctx, (processId) => {
    if (tab === 'logs') connection.watch(processId);
  });
  const notices = createNoticesTab(
    els.notices,
    { button: els.noticesTab, badge: els.unreadBadge },
    ctx,
    me.deviceId,
  );
  const settings = createSettingsTab(els.settings, ctx, me);
  const confirm = createConfirmDialog(els.confirm, ctx);

  function paintStatus(): void {
    els.reconnecting.hidden = live || !(everLive || readFailed);
    groups.setLive(live, everLive || readFailed);
  }

  /** `now` is main's clock at the moment it sent this, when it is fresh. */
  function applyState(state: RemoteStateView, now?: number): void {
    current = state;
    if (now) skew = now - env.now();
    groups.render(state);
    logs.render(state);
    notices.render(state);
    settings.renderUpdate(state.update);
    confirm.update(state.confirms);
  }

  function onEvent(name: string, data: unknown): void {
    if (name === 'state') {
      const state = stateView(data);
      applyState(state, state.now);
    } else if (name === 'log') logs.append(logBatch(data));
    else if (name === 'notice') {
      const notice = noticeView(data);
      if (notice) notices.add(notice);
    } else if (current && name === 'confirm') {
      const { now, confirms } = confirmsView(data);
      applyState({ ...current, confirms }, now);
    } else if (current && name === 'update')
      applyState({ ...current, update: updateView(data) });
  }

  const refresh = (): void => {
    client.state().then(
      (state) => applyState(state, state.now),
      () => {
        readFailed = true;
        paintStatus();
      },
    );
    client.notices().then(
      (list) => notices.set(list),
      () => undefined,
    );
  };

  const connection = createConnection({
    openEvents: (url) => env.openEvents(url),
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
    clearTimeout: (handle) => env.clearTimeout(handle),
    events: () => client.events(),
    check,
    subscribe: (id) => client.call('logs.subscribe', { id }),
    onEvent,
    onStatus: (status) => {
      const back = status === 'live' && everLive;
      live = status === 'live';
      if (live) everLive = true;
      paintStatus();
      // The stream sends a fresh state on connect; what it does not resend
      // is the notices and the log tail missed while it was down.
      if (back) {
        client.notices().then(
          (list) => notices.set(list),
          () => undefined,
        );
        if (tab === 'logs') logs.show();
      }
    },
    onUnlinked: toldUnlinked,
    reload: () => env.reload(),
  });

  function showTab(next: TabName): void {
    tab = next;
    for (const name of TABS) {
      const panel = document.querySelector<HTMLElement>(`[data-tab="${name}"]`);
      if (panel) panel.hidden = name !== next;
      const control = document.querySelector(`[data-tab-button="${name}"]`);
      if (name === next) control?.setAttribute('aria-current', 'page');
      else control?.removeAttribute('aria-current');
    }
    if (next === 'logs') logs.show();
    else connection.watch(null);
    if (next === 'settings') settings.show();
  }

  for (const name of TABS)
    document
      .querySelector(`[data-tab-button="${name}"]`)
      ?.addEventListener('click', () => showTab(name));

  const clock = env.setInterval(() => {
    for (const fns of tickers.values()) for (const fn of fns) fn();
  }, 1000);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    connection.close();
    env.clearInterval(clock);
    if (toastTimer !== null) env.clearTimeout(toastTimer);
    confirm.stop();
    if (els.branches.sheet.open) els.branches.sheet.close();
  }

  els.groups.hostName.textContent = me.hostName;
  showTab('groups');
  paintStatus();
  refresh();

  return { stop };
}
