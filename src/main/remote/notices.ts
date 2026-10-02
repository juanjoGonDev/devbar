import type {
  RemoteNotice,
  RemoteNoticeKind,
} from '../../ipc-contract/remote-wire.js';

/**
 * «Avisos» on a linked phone: what DevBar told the user lately — toasts,
 * completions and update banners — kept in memory (the last 50, newest
 * first). Nothing here is persisted; a restart starts an empty log, and each
 * phone keeps its own read marks.
 */

const NOTICE_LIMIT = 50;
/** Banner titles all read «DevBar — …»; the phone already says DevBar. */
const BANNER_PREFIX = /^DevBar — /;

type NoticeInput = Pick<RemoteNotice, 'kind' | 'title' | 'body'>;

export interface NoticeLog {
  add(input: NoticeInput): RemoteNotice;
  /** Newest first. */
  list(): RemoteNotice[];
}

export function toastNotice(kind: string, message: string): NoticeInput {
  const kinds: Record<string, RemoteNoticeKind> = {
    ok: 'success',
    error: 'error',
  };
  return { kind: kinds[kind] ?? 'info', title: message, body: '' };
}

const capitalized = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

export function bannerNotice(banner: {
  title: string;
  body: string;
  action: string | null;
}): NoticeInput {
  const title = capitalized(banner.title.replace(BANNER_PREFIX, ''));
  const { body } = banner;
  let kind: RemoteNoticeKind = 'info';
  // Every update banner carries a call to action (open the pane, restart).
  if (banner.action !== null) kind = 'update';
  else if (title === 'Acción programada')
    kind = body.includes('falló') ? 'error' : 'scheduled';
  else if (title === 'Pre-scripts') kind = 'success';
  return { kind, title, body };
}

export function createNoticeLog(deps: { now: () => number }): NoticeLog {
  const notices: RemoteNotice[] = [];
  let nextId = 1;
  return {
    add: (input) => {
      const notice = { id: nextId++, ts: deps.now(), ...input };
      notices.unshift(notice);
      notices.length = Math.min(notices.length, NOTICE_LIMIT);
      return notice;
    },
    list: () => [...notices],
  };
}
