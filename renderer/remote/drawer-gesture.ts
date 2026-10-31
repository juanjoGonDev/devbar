/**
 * The swipe behind the phone's side menu, as pure decisions over pointer
 * samples (renderer/remote/drawer.ts feeds it real pointer events):
 *
 *   - closed, only a press within EDGE_PX of the left edge may open it;
 *     open, a press anywhere may close it;
 *   - nothing happens until the finger moves SLOP_PX, and then only if the
 *     move is mostly horizontal — a vertical one is left to scroll the page;
 *   - while dragging, the drawer follows the finger (`progress`, 0 closed …
 *     1 open, as a share of its width);
 *   - on release, a quick flick wins; otherwise it settles open once 40% of
 *     it is out, so closing an open one takes a 40% drag to the left.
 */

export const EDGE_PX = 24;
const SLOP_PX = 10;
const SETTLE_SHARE = 0.4;
/** px/ms: about a drawer's width in half a second. */
const FLICK_SPEED = 0.5;
/** A flick is read from the moves of this last stretch of the drag. */
const FLICK_WINDOW_MS = 100;

export interface Sample {
  x: number;
  y: number;
  /** ms, any monotonic clock. */
  t: number;
}

export interface Gesture {
  /** Whether the drawer was open when the press started. */
  readonly wasOpen: boolean;
  readonly phase: 'pending' | 'dragging' | 'ignored';
  /** 0 closed … 1 open. */
  readonly progress: number;
  readonly samples: readonly Sample[];
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** A gesture for this press, or null when it cannot move the drawer. */
export function startGesture(sample: Sample, open: boolean): Gesture | null {
  if (!open && sample.x > EDGE_PX) return null;
  return {
    wasOpen: open,
    phase: 'pending',
    progress: open ? 1 : 0,
    samples: [sample],
  };
}

export function moveGesture(
  gesture: Gesture,
  sample: Sample,
  width: number,
): Gesture {
  if (gesture.phase === 'ignored') return gesture;
  const [origin = sample] = gesture.samples;
  const dx = sample.x - origin.x;
  const dy = sample.y - origin.y;
  let phase: Gesture['phase'] = gesture.phase;
  if (phase === 'pending') {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP_PX)
      return { ...gesture, samples: [...gesture.samples, sample] };
    phase = Math.abs(dx) > Math.abs(dy) ? 'dragging' : 'ignored';
    if (phase === 'ignored') return { ...gesture, phase };
  }
  return {
    ...gesture,
    phase,
    progress: clamp((gesture.wasOpen ? 1 : 0) + dx / width),
    samples: [...gesture.samples, sample],
  };
}

/** px/ms over the last stretch of the drag (positive: to the right). */
function speed(samples: readonly Sample[]): number {
  const last = samples.at(-1);
  if (!last) return 0;
  const recent = samples.filter((s) => s.t >= last.t - FLICK_WINDOW_MS);
  const oldest = recent[0];
  const from = oldest === last ? samples.at(-2) : oldest;
  if (!from || last.t <= from.t) return 0;
  return (last.x - from.x) / (last.t - from.t);
}

/**
 * Where the drawer settles: true open, false closed, null when the press
 * never became a drag (a tap, or a scroll) and the drawer stays as it was.
 */
export function endGesture(gesture: Gesture, width: number): boolean | null {
  if (gesture.phase !== 'dragging' || width <= 0) return null;
  const velocity = speed(gesture.samples);
  if (velocity >= FLICK_SPEED) return true;
  if (velocity <= -FLICK_SPEED) return false;
  return gesture.wasOpen
    ? gesture.progress > 1 - SETTLE_SHARE
    : gesture.progress >= SETTLE_SHARE;
}
