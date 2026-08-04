'use strict';

// Passive completion banner. Content comes via query params; main owns the
// lifetime (auto-close timer). Clicking anywhere dismisses it immediately.
const q = new URLSearchParams(location.search);

document.getElementById('title').textContent = q.get('title') || 'DevBar';
document.getElementById('body').textContent = q.get('body') || '';

const logoEl = document.getElementById('logo');
const logo = q.get('logo');
if (logo) logoEl.src = logo;
else logoEl.style.display = 'none';

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
