/**
 * The live button: «● En directo» while the view follows the tail, «En pausa ·
 * N nuevas» once it does not. The transitions live in `live-state.ts`; this
 * only holds the current state on `view` and keeps the button in step with it.
 *
 * Resuming needs the pane (redraw at the tail, flush what was held), so the
 * button's click is wired in `pane.ts`, which sits above this module.
 */
import { liveLabel, nextLive, type LiveEvent } from './live-state.js';
import { liveBtn, liveTextEl, setText } from './elements.js';
import { view } from './view.js';

export function paintLive(): void {
  const label = liveLabel(view.live);
  setText(liveTextEl, label.text);
  liveBtn.title = label.title;
  liveBtn.setAttribute('aria-pressed', String(view.live.following));
  liveBtn.classList.toggle('paused', !view.live.following);
}

/** Apply one event, repainting only when the state actually moved. */
export function dispatchLive(event: LiveEvent): void {
  const next = nextLive(view.live, event);
  if (next === view.live) return;
  view.live = next;
  paintLive();
}
