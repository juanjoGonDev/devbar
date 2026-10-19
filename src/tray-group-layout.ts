/**
 * Where the groups hidden from the tray go: after the rest, behind the
 * «N oculto(s)» fold — or, with the fold turned off in the settings, nowhere.
 * One rule for the tray popover and for a linked phone, so the two never
 * disagree about which groups they list.
 */

export interface TrayGroupLayout<T> {
  /** The groups listed as usual, in their order. */
  shown: T[];
  /** The hidden ones, listed behind the fold; empty when it is off. */
  folded: T[];
}

export function trayGroupLayout<T extends { group: { hiddenInTray: boolean } }>(
  states: readonly T[],
  showHiddenGroupsFold: boolean,
): TrayGroupLayout<T> {
  return {
    shown: states.filter((state) => !state.group.hiddenInTray),
    folded: showHiddenGroupsFold
      ? states.filter((state) => state.group.hiddenInTray)
      : [],
  };
}
