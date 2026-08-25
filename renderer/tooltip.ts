/**
 * App-wide tooltips.
 *
 * The native `title` attribute waits about a second before appearing, which is
 * long enough that most people never see it — and it cannot be styled. Rather
 * than rewrite every `title=` in every template, this hooks the document once
 * and takes them over: on hover the title is moved into `data-tip` (so macOS
 * never gets the chance to draw its own) and a styled bubble is shown instead.
 *
 * Moving the attribute rather than copying it is what makes dynamic titles keep
 * working: code that reassigns `el.title` later simply gets stolen again on the
 * next hover.
 */

const DELAY_MS = 250;
const GAP = 6;
const MARGIN = 8;

let bubble: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let anchor: HTMLElement | null = null;

function ensureBubble(): HTMLDivElement {
  if (bubble) return bubble;
  const node = document.createElement('div');
  // Styles live here, not in three separate stylesheets, so every window that
  // imports this module gets the same bubble with no extra wiring.
  //
  // The size caps are viewport-relative on purpose: the tray popover is about
  // 380px wide and sizes itself from its content, so a bubble that can spill
  // past the window edge is a bubble that grows a scrollbar.
  // `popover` promotes the bubble to the browser's TOP LAYER, the same place
  // `<dialog>.showModal()` puts a modal. That layer is above every z-index in
  // the normal layer, so without this a tooltip over a modal renders behind it
  // no matter how large its z-index. Top layer also anchors it to the viewport
  // regardless of any filtered ancestor.
  node.setAttribute('popover', 'manual');
  node.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    // Undo the UA popover defaults (inset:0 + margin:auto centre it).
    'inset:auto',
    'margin:0',
    'padding:5px 9px',
    'border-radius:6px',
    'border:1px solid rgba(255,255,255,0.14)',
    'background:#2f2f34',
    'color:#e5e5e7',
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
    'font-size:11px',
    'font-weight:400',
    'line-height:1.35',
    `max-width:min(280px, calc(100vw - ${MARGIN * 2}px))`,
    `max-height:calc(100vh - ${MARGIN * 2}px)`,
    'overflow:hidden',
    'box-shadow:0 6px 18px rgba(0,0,0,0.45)',
    'pointer-events:none',
    'contain:layout paint',
    'opacity:0',
    'transition:opacity 0.1s ease',
  ].join(';');
  bubble = node;
  return node;
}

/** Detach rather than hide: a node outside the DOM cannot affect any layout. */
function hide(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  anchor = null;
  if (!bubble) return;
  bubble.style.opacity = '0';
  if (bubble.isConnected && supportsPopover()) {
    try {
      bubble.hidePopover();
    } catch {
      /* already hidden — nothing to undo */
    }
  }
  bubble.remove();
}

function supportsPopover(): boolean {
  return typeof HTMLElement.prototype.showPopover === 'function';
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Where the bubble goes: below the anchor by default, flipped above only when
 * there is genuinely no room, and always clamped inside the viewport. Kept
 * pure so the awkward cases — an anchor at the very bottom, a wide tip on a
 * narrow tray popover — can be checked without a browser.
 */
export function placeTip(
  anchorBox: Box,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const below = anchorBox.bottom + GAP;
  const fitsBelow = below + tip.height + MARGIN <= viewport.height;
  const top = fitsBelow
    ? below
    : Math.max(MARGIN, anchorBox.top - GAP - tip.height);
  const left = Math.min(
    Math.max(MARGIN, anchorBox.left),
    Math.max(MARGIN, viewport.width - tip.width - MARGIN),
  );
  return { left: Math.round(left), top: Math.round(top) };
}

function place(target: HTMLElement, text: string): void {
  const node = ensureBubble();
  node.textContent = text;
  // Attach off-screen to measure, so the un-placed bubble is never painted at
  // 0,0 and never briefly overlaps the corner of the window.
  node.style.left = '-9999px';
  node.style.top = '-9999px';
  // Mounted on <html>, NOT <body>: `body.tray` carries a `backdrop-filter`,
  // and a filtered element becomes the containing block for its
  // `position: fixed` descendants — a bubble inside it stops being anchored to
  // the viewport, picks up the body's padding as an offset, and can overflow
  // the body box into real scrollable area. Promoting to the top layer below
  // fixes that too, but this keeps the fallback path honest.
  document.documentElement.appendChild(node);
  if (supportsPopover()) {
    try {
      node.showPopover();
    } catch {
      /* already open — the position update below is all that is needed */
    }
  }

  const { left, top } = placeTip(
    target.getBoundingClientRect(),
    node.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
  );
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.opacity = '1';
}

/** The tip text for an element, stealing `title` the first time we see it. */
function tipFor(el: HTMLElement): string {
  const native = el.getAttribute('title');
  if (native !== null && native.trim() !== '') {
    el.dataset.tip = native;
    // Keep the label reachable for assistive tech, which would otherwise lose
    // it along with the attribute we just removed.
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby'))
      el.setAttribute('aria-label', native);
    el.removeAttribute('title');
  }
  return el.dataset.tip ?? '';
}

export function installTooltips(): void {
  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest<HTMLElement>('[title],[data-tip]');
    if (!el || el === anchor) return;
    const text = tipFor(el);
    if (!text) return;
    hide();
    anchor = el;
    timer = setTimeout(() => {
      timer = null;
      if (anchor === el && el.isConnected) place(el, text);
    }, DELAY_MS);
  });

  document.addEventListener('mouseout', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (anchor && target.closest('[title],[data-tip]') === anchor) hide();
  });

  // Anything that moves the page out from under the bubble dismisses it: a
  // tooltip left floating over unrelated content is worse than none.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
