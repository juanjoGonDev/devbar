// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltips, placeTip, type Box } from '../renderer/tooltip.js';

function box(left: number, top: number, width = 60, height = 16): Box {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

const TIP = { width: 200, height: 28 };
const VIEW = { width: 900, height: 600 };

/** The delay before a hovered title becomes a bubble, per `tooltip.ts`. */
const DELAY_MS = 250;

function stubRect(el: Element, rect: Partial<DOMRect>): void {
  const full: DOMRect = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  };
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => full,
  });
}

describe('renderer/tooltip.ts', () => {
  // The module hooks the document ONCE and keeps its bubble, timer and anchor
  // in module state, so the suite installs it once too and resets the state
  // between tests through the dismissal the module itself listens for.
  installTooltips();

  beforeEach(() => {
    vi.useFakeTimers();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function bubble(): HTMLElement | null {
    return document.documentElement.querySelector<HTMLElement>(
      '[popover="manual"]',
    );
  }

  function anchor(html: string): HTMLElement {
    document.body.innerHTML = html;
    const el = document.body.firstElementChild;
    if (!(el instanceof HTMLElement)) throw new Error('no anchor built');
    return el;
  }

  function hover(el: Element): void {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }

  function unhover(el: Element, relatedTarget: Element | null = null): void {
    el.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget }),
    );
  }

  interface PopoverSpies {
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    restore: () => void;
  }

  /** jsdom has no popover API, so the top-layer path needs one installed. */
  function withPopover(): PopoverSpies {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const show = vi.fn();
    const hide = vi.fn();
    proto.showPopover = show;
    proto.hidePopover = hide;
    return {
      show,
      hide,
      restore: () => {
        delete proto.showPopover;
        delete proto.hidePopover;
      },
    };
  }

  describe('placeTip', () => {
    it('sits just below the anchor when there is room', () => {
      const { top } = placeTip(box(100, 100), TIP, VIEW);
      expect(top).toBe(100 + 16 + 6); // anchor bottom + gap
    });

    it('left-aligns with the anchor when it fits', () => {
      expect(placeTip(box(100, 100), TIP, VIEW).left).toBe(100);
    });

    it('flips above when the anchor is at the bottom edge', () => {
      const anchorBox = box(100, 580);
      const { top } = placeTip(anchorBox, TIP, VIEW);
      expect(top).toBe(580 - 6 - 28); // anchor top - gap - tip height
      expect(top + TIP.height).toBeLessThan(anchorBox.top);
    });

    it('clamps to the right edge instead of overflowing', () => {
      const { left } = placeTip(box(850, 100), TIP, VIEW);
      expect(left).toBe(900 - 200 - 8);
      expect(left + TIP.width).toBeLessThanOrEqual(900);
    });

    it('never goes past the left margin', () => {
      expect(placeTip(box(0, 100), TIP, VIEW).left).toBe(8);
    });

    it('stays on screen in a viewport narrower than the tip', () => {
      // The tray popover is ~380px wide; a long tip must not run off it.
      const { left } = placeTip(
        box(10, 40),
        { width: 500, height: 28 },
        {
          width: 380,
          height: 500,
        },
      );
      expect(left).toBe(8);
    });

    it('keeps the top margin when flipping in a very short viewport', () => {
      const { top } = placeTip(box(10, 10), TIP, { width: 900, height: 40 });
      expect(top).toBeGreaterThanOrEqual(8);
    });
  });

  describe('taking over the native title', () => {
    it('moves the title into data-tip so the OS never draws its own', () => {
      const el = anchor('<button title="Ver changelog">v1</button>');
      hover(el);
      expect(el.hasAttribute('title')).toBe(false);
      expect(el.dataset.tip).toBe('Ver changelog');
    });

    it('mirrors the stolen title into aria-label so the name survives', () => {
      const el = anchor('<button title="Salir">x</button>');
      hover(el);
      expect(el.getAttribute('aria-label')).toBe('Salir');
    });

    it('leaves an existing aria-label alone', () => {
      const el = anchor('<button title="Salir" aria-label="Cerrar">x</button>');
      hover(el);
      expect(el.getAttribute('aria-label')).toBe('Cerrar');
    });

    it('leaves an element named by aria-labelledby alone', () => {
      const el = anchor('<button title="Salir" aria-labelledby="h">x</button>');
      hover(el);
      expect(el.hasAttribute('aria-label')).toBe(false);
    });

    it('keeps working when the code reassigns the title later', () => {
      const el = anchor('<button title="uno">x</button>');
      hover(el);
      unhover(el);
      el.title = 'dos';
      hover(el);
      expect(el.dataset.tip).toBe('dos');
      expect(el.hasAttribute('title')).toBe(false);
    });

    it('ignores an empty title', () => {
      const el = anchor('<button title="">x</button>');
      hover(el);
      vi.advanceTimersByTime(DELAY_MS + 10);
      expect(bubble()).toBeNull();
      expect(el.hasAttribute('title')).toBe(true);
    });

    it('ignores an element with nothing to say', () => {
      const el = anchor('<button>x</button>');
      hover(el);
      vi.advanceTimersByTime(DELAY_MS + 10);
      expect(bubble()).toBeNull();
    });
  });

  describe('showing the bubble', () => {
    it('waits before showing anything', () => {
      hover(anchor('<button title="Salir">x</button>'));
      vi.advanceTimersByTime(DELAY_MS - 1);
      expect(bubble()).toBeNull();
    });

    it('shows the tip text once the delay is up', () => {
      hover(anchor('<button title="Salir">x</button>'));
      vi.advanceTimersByTime(DELAY_MS);
      expect(bubble()?.textContent).toBe('Salir');
    });

    it('mounts on <html>, never inside the filtered tray body', () => {
      // `body.tray` carries a backdrop-filter, which would make it the
      // containing block for a position:fixed bubble.
      hover(anchor('<button title="Salir">x</button>'));
      vi.advanceTimersByTime(DELAY_MS);
      expect(bubble()?.parentElement).toBe(document.documentElement);
    });

    it('fades the bubble in rather than leaving it at the measuring opacity', () => {
      hover(anchor('<button title="Salir">x</button>'));
      vi.advanceTimersByTime(DELAY_MS);
      expect(bubble()?.style.opacity).toBe('1');
    });

    it('places the bubble under its anchor', () => {
      const el = anchor('<button title="Salir">x</button>');
      stubRect(el, { left: 120, top: 40, right: 180, bottom: 56 });
      hover(el);
      vi.advanceTimersByTime(DELAY_MS);
      expect(bubble()?.style.left).toBe('120px');
      expect(bubble()?.style.top).toBe('62px');
    });

    it('reads a data-tip that was never a title attribute', () => {
      hover(anchor('<span data-tip="Rama actual">main</span>'));
      vi.advanceTimersByTime(DELAY_MS);
      expect(bubble()?.textContent).toBe('Rama actual');
    });

    it('finds the tip on an ancestor when the pointer lands on a child', () => {
      const el = anchor('<button title="Salir"><span>x</span></button>');
      const child = el.firstElementChild;
      if (!child) throw new Error('no child');
      hover(child);
      vi.advanceTimersByTime(DELAY_MS);
      expect(bubble()?.textContent).toBe('Salir');
    });

    it('drops a tip whose anchor left the page while the delay ran', () => {
      const el = anchor('<button title="Salir">x</button>');
      hover(el);
      el.remove();
      vi.advanceTimersByTime(DELAY_MS + 10);
      expect(bubble()).toBeNull();
    });

    it('ignores a hover whose target is not an element', () => {
      document.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(DELAY_MS + 10);
      expect(bubble()).toBeNull();
    });
  });

  describe('dismissing the bubble', () => {
    function shown(): HTMLElement {
      const el = anchor('<button title="Salir"><span>x</span></button>');
      hover(el);
      vi.advanceTimersByTime(DELAY_MS);
      if (!bubble()) throw new Error('the bubble never appeared');
      return el;
    }

    it('detaches the bubble when the pointer leaves', () => {
      const el = shown();
      unhover(el);
      expect(bubble()).toBeNull();
    });

    it('survives the pointer crossing between the control’s own children', () => {
      // Moving from a button's icon to its label fires mouseout. Hiding there
      // would cancel the timer and the follow-up mouseover would restart the
      // delay, so the tip could never appear on a two-part control.
      const el = shown();
      const child = el.firstElementChild;
      if (!child) throw new Error('no child');
      unhover(el, child);
      expect(bubble()).not.toBeNull();
    });

    it('ignores a mouseout that belongs to a different control', () => {
      shown();
      const other = document.createElement('button');
      other.title = 'otro';
      document.body.appendChild(other);
      unhover(other);
      expect(bubble()).not.toBeNull();
    });

    it('ignores a mouseout whose target is not an element', () => {
      shown();
      document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      expect(bubble()).not.toBeNull();
    });

    it('dismisses on any click', () => {
      shown();
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(bubble()).toBeNull();
    });

    it('dismisses on any keystroke', () => {
      shown();
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      expect(bubble()).toBeNull();
    });

    it('dismisses when the page scrolls out from under it', () => {
      shown();
      window.dispatchEvent(new Event('scroll'));
      expect(bubble()).toBeNull();
    });

    it('dismisses when the window loses focus', () => {
      shown();
      window.dispatchEvent(new Event('blur'));
      expect(bubble()).toBeNull();
    });

    it('cancels a pending tip when the pointer moves to another control', () => {
      const first = anchor('<button title="uno">1</button>');
      const second = document.createElement('button');
      second.title = 'dos';
      document.body.appendChild(second);
      hover(first);
      hover(second);
      vi.advanceTimersByTime(DELAY_MS);
      expect(bubble()?.textContent).toBe('dos');
    });

    it('does not restart the delay while the pointer stays on one control', () => {
      const el = anchor('<button title="Salir">x</button>');
      hover(el);
      vi.advanceTimersByTime(DELAY_MS - 50);
      hover(el);
      vi.advanceTimersByTime(50);
      expect(bubble()?.textContent).toBe('Salir');
    });
  });

  describe('the browser top layer', () => {
    it('promotes the bubble so it can never render behind a modal', () => {
      const popover = withPopover();
      try {
        hover(anchor('<button title="Salir">x</button>'));
        vi.advanceTimersByTime(DELAY_MS);
        expect(popover.show).toHaveBeenCalled();
      } finally {
        popover.restore();
      }
    });

    it('takes the bubble back out of the top layer when it hides', () => {
      const popover = withPopover();
      try {
        hover(anchor('<button title="Salir">x</button>'));
        vi.advanceTimersByTime(DELAY_MS);
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(popover.hide).toHaveBeenCalled();
        expect(bubble()).toBeNull();
      } finally {
        popover.restore();
      }
    });

    it('shrugs off a browser that refuses the call', () => {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      proto.showPopover = () => {
        throw new Error('already open');
      };
      proto.hidePopover = () => {
        throw new Error('already hidden');
      };
      try {
        hover(anchor('<button title="Salir">x</button>'));
        vi.advanceTimersByTime(DELAY_MS);
        expect(bubble()?.textContent).toBe('Salir');
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(bubble()).toBeNull();
      } finally {
        delete proto.showPopover;
        delete proto.hidePopover;
      }
    });
  });
});
