import { icon, iconButton } from '../icon.js';
import {
  attachResizeHandle,
  clampWidth,
  readStoredValue,
  writeStoredValue,
} from '../config/resize-handle.js';

const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 232;
const WIDTH_KEY = 'pipeline-panel-width';
const COLLAPSED_KEY = 'pipeline-panel-collapsed';

export interface PipelinePanel {
  /** The floating panel itself. */
  panel: HTMLElement;
  /** Folds or unfolds the panel (the breadcrumb's toggle). */
  toggle(): void;
  isOpen(): boolean;
  search: HTMLInputElement;
  list: HTMLElement;
  /** "Nuevo pre-script": present only when the editor can create one. */
  newButton: HTMLButtonElement | null;
  /** Screen pixels the panel covers from the canvas's left edge (0 if folded). */
  coveredWidth(): number;
}

function storedWidth(): number {
  const value = Number(readStoredValue(WIDTH_KEY) ?? NaN);
  return Number.isFinite(value)
    ? clampWidth(value, MIN_WIDTH, MAX_WIDTH)
    : DEFAULT_WIDTH;
}

/**
 * The pre-scripts panel that floats over the top-left of the canvas, under
 * the breadcrumb (whose toggle reopens it): collapsible, and resizable by its
 * right edge
 * (180–360px). Both choices persist per window in localStorage.
 */
export function createPipelinePanel(options: {
  canCreate: boolean;
  onLayoutChange(): void;
}): PipelinePanel {
  const panel = document.createElement('aside');
  panel.className = 'pipeline-panel';
  panel.setAttribute('aria-label', 'Pre-scripts');

  const head = document.createElement('div');
  head.className = 'pipeline-panel-head';
  const title = document.createElement('h3');
  title.className = 'pipeline-panel-title';
  title.textContent = 'Pre-scripts';
  const collapse = iconButton(
    'panel-left-close',
    'Plegar panel',
    'pipeline-icon-btn pipeline-panel-collapse',
  );
  head.append(title, collapse);

  let newButton: HTMLButtonElement | null = null;
  if (options.canCreate) {
    newButton = document.createElement('button');
    newButton.type = 'button';
    newButton.className = 'add-group-btn pipeline-panel-new';
    const label = document.createElement('span');
    label.textContent = 'Nuevo pre-script';
    newButton.append(icon('plus'), label);
  }

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'pipeline-palette-search';
  search.placeholder = 'Buscar…';
  search.setAttribute('aria-label', 'Buscar pre-script');

  const list = document.createElement('div');
  list.className = 'pipeline-palette-list';

  const handle = document.createElement('div');
  handle.className = 'pipeline-panel-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Redimensionar panel');
  handle.tabIndex = 0;

  panel.append(head, ...(newButton ? [newButton] : []), search, list, handle);

  let width = storedWidth();
  let collapsed = readStoredValue(COLLAPSED_KEY) === 'true';

  function paint(): void {
    panel.style.setProperty('--pipeline-panel-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
    panel.hidden = collapsed;
  }

  function setCollapsed(next: boolean): void {
    collapsed = next;
    writeStoredValue(COLLAPSED_KEY, next ? 'true' : null);
    paint();
    if (!next) search.focus({ preventScroll: true });
    options.onLayoutChange();
  }

  collapse.addEventListener('click', () => setCollapsed(true));

  attachResizeHandle({
    handle,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    current: () => width,
    preview: (next) => {
      width = next;
      paint();
    },
    commit: (next) => {
      width = next;
      writeStoredValue(WIDTH_KEY, String(next));
      paint();
      options.onLayoutChange();
    },
    onDragStart: () => panel.classList.add('is-resizing'),
    onDragEnd: () => panel.classList.remove('is-resizing'),
  });

  paint();
  return {
    panel,
    toggle: () => setCollapsed(!collapsed),
    isOpen: () => !collapsed,
    search,
    list,
    newButton,
    // 12px inset on each side of the floating panel.
    coveredWidth: () => (collapsed ? 0 : width + 24),
  };
}
