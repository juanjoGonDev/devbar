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

function dismiss() {
  if (window.api && window.api.dismissNotification)
    window.api.dismissNotification();
}
document.getElementById('close').addEventListener('click', (e) => {
  e.stopPropagation();
  dismiss();
});
document.getElementById('banner').addEventListener('click', dismiss);
