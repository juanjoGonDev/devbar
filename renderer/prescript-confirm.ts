import { byId } from './dom.js';
import { installTooltips } from './tooltip.js';
const token = new URLSearchParams(window.location.search).get('token');
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let decided = false;
function decide(decision: 'confirm' | 'cancel'): void {
  if (decided || !token) return;
  decided = true;
  if (countdownInterval) clearInterval(countdownInterval);
  void window.api.resolvePrescriptConfirm(token, decision);
}
async function init(): Promise<void> {
  if (!token) {
    window.close();
    return;
  }
  const context = await window.api.getPrescriptConfirmContext(token);
  if (!context) {
    window.close();
    return;
  }
  const logo = byId('pc-logo', HTMLImageElement);
  if (context.logo) logo.src = context.logo;
  else logo.style.display = 'none';
  byId('pc-title', HTMLElement).textContent = `¿Ejecutar «${context.name}»?`;
  byId('pc-cmd', HTMLElement).textContent = context.command;
  if (context.secs != null) {
    const button = byId(
      context.onTimeout === 'confirm' ? 'pc-btn-confirm' : 'pc-btn-cancel',
      HTMLButtonElement,
    );
    const base = button.textContent.trim();
    let left = context.secs;
    const paint = (): void => {
      button.textContent = left > 0 ? `${base} (${left}s)` : base;
    };
    paint();
    countdownInterval = setInterval(() => {
      left -= 1;
      if (left <= 0 && countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      paint();
    }, 1000);
  }
}
byId('pc-btn-confirm', HTMLButtonElement).addEventListener('click', () =>
  decide('confirm'),
);
byId('pc-btn-cancel', HTMLButtonElement).addEventListener('click', () =>
  decide('cancel'),
);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') decide('confirm');
  else if (event.key === 'Escape') decide('cancel');
});
void init();

installTooltips();
