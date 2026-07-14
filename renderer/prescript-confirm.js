'use strict';

/**
 * prescript-confirm.js — self-contained renderer for the per-pre-script
 * confirmation modal. Reads `token` from the query string, fetches context
 * over IPC, renders it, and resolves the decision back to main.
 *
 * The countdown shown here is COSMETIC ONLY: main.js owns the authoritative
 * auto-resolve timer (ADR-1). This renderer never resolves on its own when
 * the countdown reaches zero — it just freezes the label.
 */

(() => {
  const token = new URLSearchParams(window.location.search).get('token');
  let countdownInterval = null;
  let decided = false;

  function decide(decision) {
    if (decided) return; // defensive; main's token-map is the real guard
    decided = true;
    if (countdownInterval) clearInterval(countdownInterval);
    window.api.resolvePrescriptConfirm(token, decision);
  }

  async function init() {
    const ctx = await window.api.getPrescriptConfirmContext(token);
    if (!ctx) {
      window.close();
      return;
    }

    const logoEl = document.getElementById('pc-logo');
    if (ctx.logo) {
      logoEl.src = ctx.logo;
    } else {
      logoEl.style.display = 'none';
    }

    document.getElementById('pc-title').textContent =
      `¿Ejecutar «${ctx.name}»?`;
    document.getElementById('pc-cmd').textContent = ctx.command;

    // Countdown lives ON the button that will fire automatically (macOS
    // style): e.g. "Cancelar (60s)" ticking down. The other button stays
    // static. Cosmetic only — main owns the authoritative timer (ADR-1),
    // so at 0 we just freeze the base label and let main resolve.
    if (ctx.secs != null) {
      const targetBtn = document.getElementById(
        ctx.onTimeout === 'confirm' ? 'pc-btn-confirm' : 'pc-btn-cancel',
      );
      const baseLabel = targetBtn.textContent.trim();
      let left = ctx.secs;
      const paint = () => {
        targetBtn.textContent =
          left > 0 ? `${baseLabel} (${left}s)` : baseLabel;
      };
      paint();
      countdownInterval = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null; // STOP here — do NOT resolve (ADR-1)
        }
        paint();
      }, 1000);
    }
  }

  document
    .getElementById('pc-btn-confirm')
    .addEventListener('click', () => decide('confirm'));
  document
    .getElementById('pc-btn-cancel')
    .addEventListener('click', () => decide('cancel'));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') decide('confirm');
    else if (e.key === 'Escape') decide('cancel');
  });

  init();
})();
