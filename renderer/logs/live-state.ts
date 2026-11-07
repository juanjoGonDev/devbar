/**
 * Whether the log is live — following its tail — or paused, and why.
 *
 * One button stands for what used to be two switches («Auto-scroll» and
 * «Pausa»). They were never independent: scrolling up already stopped the
 * tail from dragging you along, and pausing only made sense while you were
 * reading something. So there is one state with two ways into the pause:
 *
 * - `scroll` — you left the tail (scrolled up, jumped to a line). Lines keep
 *   landing in the buffer; you are just not dragged to them, and scrolling
 *   back down resumes on its own.
 * - `manual` — you pressed the button. Arriving lines are HELD back from the
 *   buffer, as «Pausa» did, so what is on screen stops moving altogether.
 *   Only pressing again (or the jump-to-bottom button) resumes.
 *
 * Either way `unseen` counts what arrived meanwhile, for «N nuevas».
 *
 * Pure on purpose: the transitions are the whole feature, and they are
 * checked here without a window.
 */

type PauseCause = 'scroll' | 'manual';

export interface LiveState {
  /** Following the tail: new lines are drawn and scrolled to. */
  following: boolean;
  /** Why it is paused; null while following. */
  cause: PauseCause | null;
  /** Lines that arrived since the pause began. */
  unseen: number;
}

export type LiveEvent =
  /** The reader moved away from the tail (scrolled up, jumped to a line). */
  | { type: 'leftTail' }
  /** The reader is back at the tail; `canResume` is false while lines are selected. */
  | { type: 'reachedTail'; canResume: boolean }
  /** The live button was pressed. */
  | { type: 'press' }
  /** Back to the tail, following, whatever the cause was. */
  | { type: 'resume' }
  /** Lines arrived. */
  | { type: 'arrived'; count: number }
  /** The view was pointed at another log: nothing it held is unseen any more. */
  | { type: 'reset' };

export const LIVE: LiveState = Object.freeze({
  following: true,
  cause: null,
  unseen: 0,
});

function pausedBy(cause: PauseCause): LiveState {
  return { following: false, cause, unseen: 0 };
}

export function nextLive(state: LiveState, event: LiveEvent): LiveState {
  switch (event.type) {
    case 'leftTail':
      return state.following ? pausedBy('scroll') : state;
    case 'reachedTail':
      // A manual pause is not undone by scrolling: the reader said "stop".
      return state.cause === 'scroll' && event.canResume ? LIVE : state;
    case 'press':
      return state.following ? pausedBy('manual') : LIVE;
    case 'resume':
      return LIVE;
    case 'arrived':
      if (state.following || event.count <= 0) return state;
      return { ...state, unseen: state.unseen + event.count };
    case 'reset':
      return state.unseen === 0 ? state : { ...state, unseen: 0 };
  }
}

/** Lines are held back from the buffer only by a manual pause. */
export function isHolding(state: LiveState): boolean {
  return state.cause === 'manual';
}

export interface LiveLabel {
  text: string;
  title: string;
}

export function liveLabel(state: LiveState): LiveLabel {
  if (state.following)
    return {
      text: 'En directo',
      title: 'Siguiendo el final · pulsa para pausar',
    };
  return {
    text: state.unseen ? `En pausa · ${state.unseen} nuevas` : 'En pausa',
    title: 'Volver al final y seguir en directo',
  };
}
