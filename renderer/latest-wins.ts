/**
 * Guards state that two writers race for: a value the renderer reads once on
 * startup, and the same value pushed from the main process afterwards.
 *
 * The read is a promise. Nothing orders it against the pushes, so a push that
 * lands first is silently overwritten when the older read finally resolves —
 * and the window then shows a value the main process no longer holds, until
 * something unrelated triggers another push.
 *
 * The rule is the one the theme picker already uses: the newest value wins,
 * and a write may only land if nothing newer has landed since it was issued.
 *
 *   const groups = latestWins();
 *   window.api.onUpdate((gs) => {
 *     groups.invalidate();   // a pushed value is now the truth
 *     render(gs);
 *   });
 *   const current = groups.claim();          // capture BEFORE the read starts
 *   window.api.getGroupStates().then((gs) => {
 *     if (current()) render(gs);             // still newest? then write
 *   });
 *
 * `claim()` must be called before the read is issued, not inside `then` —
 * capturing after the fact would read a revision the push had already moved.
 */
export interface LatestWins {
  /** Marks a newer value as applied, retiring every outstanding claim. */
  invalidate(): void;
  /**
   * Captures the current revision and returns a predicate that reports
   * whether it is still the newest — i.e. whether this writer may still win.
   */
  claim(): () => boolean;
}

export function latestWins(): LatestWins {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    claim() {
      const captured = revision;
      return () => captured === revision;
    },
  };
}
