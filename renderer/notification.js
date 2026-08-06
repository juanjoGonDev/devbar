'use strict';

// Passive completion banner. Content comes via query params; main owns the
// lifetime (auto-close timer). Clicking anywhere dismisses it immediately.
const q = new URLSearchParams(location.search);

document.getElementById('title').textContent = q.get('title') || 'DevBar';
document.getElementById('body').textContent = q.get('body') || '';

// The logo is a static bundled asset (set in the HTML) — never a query value,
// so no untrusted data reaches img.src. Hide it if it fails to load.
const logoEl = document.getElementById('logo');
logoEl.addEventListener('error', () => {
  logoEl.style.display = 'none';
});

// Cosmetic countdown bar: shrinks over the auto-close window. Main owns the
// authoritative close timer. secs === 0 means permanent → no bar.
const secs = Number(q.get('secs')) || 0;
const progress = document.getElementById('progress');
if (secs > 0)
  progress.style.animation = `devbar-shrink ${secs}s linear forwards`;
else progress.style.display = 'none';

function dismiss() {
  if (window.api && window.api.dismissNotification)
    window.api.dismissNotification();
}
document.getElementById('close').addEventListener('click', (e) => {
  e.stopPropagation();
  dismiss();
});
document.getElementById('banner').addEventListener('click', dismiss);

// Optional call-to-action: runs a main-side action, then dismisses.
const ctaLabel = q.get('cta');
const ctaAction = q.get('action');
if (ctaLabel && ctaAction) {
  const ctaEl = document.getElementById('cta');
  ctaEl.textContent = ctaLabel;
  ctaEl.style.display = '';
  ctaEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.api && window.api.notificationAction)
      window.api.notificationAction(ctaAction);
  });
}
