import { byId } from './dom.js';
import { installTooltips } from './tooltip.js';
const query = new URLSearchParams(location.search);
byId('title', HTMLElement).textContent = query.get('title') || 'DevBar';
byId('body', HTMLElement).textContent = query.get('body') || '';
const logo = byId('logo', HTMLImageElement);
logo.addEventListener('error', () => {
  logo.style.display = 'none';
});
const secs = Number(query.get('secs')) || 0;
const progress = byId('progress', HTMLElement);
if (secs > 0)
  progress.style.animation = `devbar-shrink ${secs}s linear forwards`;
else progress.style.display = 'none';
const dismiss = (): void => {
  void window.api.dismissNotification();
};
byId('close', HTMLButtonElement).addEventListener('click', (event) => {
  event.stopPropagation();
  dismiss();
});
byId('banner', HTMLElement).addEventListener('click', dismiss);
const ctaLabel = query.get('cta');
const ctaAction = query.get('action');
if (ctaLabel && ctaAction) {
  const cta = byId('cta', HTMLButtonElement);
  cta.textContent = ctaLabel;
  cta.style.display = '';
  cta.addEventListener('click', (event) => {
    event.stopPropagation();
    void window.api.notificationAction(ctaAction);
  });
}

installTooltips();
