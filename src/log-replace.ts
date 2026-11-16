/**
 * A line a carriage return rewrote (a progress bar) comes out of the process
 * manager as a new entry that `replaces` the one before it. Everything that
 * mirrors a log buffer — a logs window, a phone's tail, a workflow run's
 * script log — finds that entry here and swaps it in place.
 */
interface Sequenced {
  readonly seq?: number | undefined;
}

/**
 * Index of the entry with seq `replaces`, or -1 when there is none to replace
 * (it was trimmed, or never delivered): the caller then appends the line as a
 * new one. Searched from the end, where the rewritten line almost always is.
 * `sameSource` keeps a merged list from matching another service's line with
 * the same number; along one source seqs only grow, so the search stops at
 * the first older one instead of walking the whole list.
 */
export function replacedIndex<T extends Sequenced>(
  list: readonly T[],
  replaces: number | undefined,
  sameSource: (candidate: T) => boolean = () => true,
): number {
  if (replaces === undefined) return -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (candidate?.seq === undefined || !sameSource(candidate)) continue;
    if (candidate.seq === replaces) return index;
    if (candidate.seq < replaces) return -1;
  }
  return -1;
}
