/**
 * The collapsible sections of the command / action / pre-script side sheet.
 * Each one is a header button (with a summary badge) over a body; which ones
 * are open is remembered per kind, so a pre-script keeps its own layout
 * apart from a command's.
 */
export type SheetKind = 'command' | 'action' | 'prescript';
type SheetSectionName = 'env' | 'exec' | 'schedule' | 'logs' | 'args';

export interface SheetSections {
  /** Shows the sections `kind` owns, opened as that kind last left them. */
  show(kind: SheetKind): void;
  setBadge(name: SheetSectionName, text: string): void;
}

/** The sections each kind owns, in their order on the sheet. */
const OWNED: Record<SheetKind, readonly SheetSectionName[]> = {
  command: ['env', 'exec', 'schedule', 'logs', 'args'],
  action: ['env', 'exec', 'schedule', 'args'],
  prescript: ['env', 'exec', 'args'],
};

const OPEN_BY_DEFAULT: ReadonlySet<SheetSectionName> = new Set(['env', 'exec']);

const storageKey = (kind: SheetKind): string => `sub-sheet-open:${kind}`;

function readOpen(kind: SheetKind): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(kind));
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((v) => typeof v === 'string'));
  } catch {
    /* unreadable or unavailable storage: fall back to the defaults */
  }
  return new Set(OPEN_BY_DEFAULT);
}

function writeOpen(kind: SheetKind, open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify([...open]));
  } catch {
    /* storage unavailable: the layout lasts this session only */
  }
}

export function createSheetSections(root: HTMLElement): SheetSections {
  const sections = [
    ...root.querySelectorAll<HTMLElement>('.sheet-section[data-section]'),
  ];
  let kind: SheetKind = 'command';
  let open = readOpen(kind);

  const toggleOf = (section: HTMLElement): HTMLButtonElement | null =>
    section.querySelector<HTMLButtonElement>('.sheet-section-toggle');

  function paint(section: HTMLElement): void {
    const isOpen = open.has(section.dataset.section ?? '');
    section.classList.toggle('is-open', isOpen);
    toggleOf(section)?.setAttribute('aria-expanded', String(isOpen));
    const body = section.querySelector<HTMLElement>('.sheet-section-body');
    if (body) body.hidden = !isOpen;
  }

  for (const section of sections) {
    toggleOf(section)?.addEventListener('click', () => {
      const name = section.dataset.section ?? '';
      if (open.has(name)) open.delete(name);
      else open.add(name);
      writeOpen(kind, open);
      paint(section);
    });
  }

  return {
    show(next) {
      kind = next;
      open = readOpen(next);
      for (const section of sections) {
        const owned = OWNED[next].includes(
          section.dataset.section as SheetSectionName,
        );
        section.hidden = !owned;
        paint(section);
      }
    },
    setBadge(name, text) {
      const badge = root.querySelector<HTMLElement>(
        `.sheet-section[data-section="${name}"] .sheet-badge`,
      );
      if (badge) badge.textContent = text;
    },
  };
}
