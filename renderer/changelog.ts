import { wireModal } from './modal.js';
import { buildReleasesHtml } from './changelog-view.js';
import { renderMarkdown, escapeHtml } from './md-mini.js';
import { closestElement } from './dom.js';

let dialog: HTMLDialogElement | null = null;
function build(): HTMLDialogElement {
  const next = document.createElement('dialog');
  next.className = 'modal modal-changelog';
  next.innerHTML = `<header class="modal-header"><h2>Changelog</h2><span class="spacer"></span><button type="button" class="small-btn" data-github>Ver en GitHub ↗</button><button type="button" class="modal-close" data-close aria-label="Cerrar">×</button></header><div class="modal-body" data-body></div>`;
  document.body.appendChild(next);
  wireModal(next);
  next.addEventListener('click', (event) => {
    const link = closestElement(event.target, '[data-href]');
    const href = link?.dataset.href;
    if (!href) return;
    event.preventDefault();
    void window.api.openExternal(href);
  });
  dialog = next;
  return next;
}

export async function openChangelog(current: string): Promise<void> {
  const active = dialog ?? build();
  const body = active.querySelector<HTMLElement>('[data-body]');
  if (!body) return;
  body.innerHTML = '<p class="cl-empty">Cargando…</p>';
  if (!active.open) active.showModal();
  const result = await window.api.getChangelog();
  const releases = Array.isArray(result?.releases) ? result.releases : [];
  body.innerHTML = buildReleasesHtml(releases, current, {
    renderMarkdown,
    escapeHtml,
  });
  const github = active.querySelector<HTMLButtonElement>('[data-github]');
  if (github)
    github.onclick = () => {
      void window.api.openExternal(
        result?.repoUrl || 'https://github.com/juanjoGonDev/devbar',
      );
    };
}
