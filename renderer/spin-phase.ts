/**
 * Phase-locks a looping CSS animation (a spinner, a pulsing dot, a sweep) to
 * the page clock. Running indicators are rebuilt whenever the elapsed time
 * next to them repaints, and a fresh element starts its animation from frame
 * zero — so every repaint visibly restarted the spin. With a negative delay
 * of the whole clock, every indicator behaves as if it had been running
 * since the page loaded: a rebuilt one lands on exactly the frame the one it
 * replaced was showing, whatever the animation's duration (including the
 * slower reduced-motion one).
 *
 * Every creator of a looping running indicator goes through here.
 */
export function spinPhase<T extends HTMLElement | SVGElement>(node: T): T {
  node.style.animationDelay = `${-performance.now()}ms`;
  return node;
}
