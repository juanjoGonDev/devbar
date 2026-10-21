import { openChangelog } from '../changelog.js';
import { closestElement } from '../dom.js';
import { renderMarkdown } from '../md-mini.js';
import { releaseHighlights } from './about-pane.js';
import type { ReleaseSummary } from '../../src/domain-types.js';

/**
 * The About page's "Novedades de <version>" card and its "Notas de la
 * versión" link, both fed by the same release list the changelog modal reads.
 * They stay hidden unless the running version has a published entry, so a
 * dev build or an offline window shows neither a blank card nor a dead link.
 */
export async function showReleaseNotes(version: string): Promise<void> {
  const card = document.getElementById('about-notes');
  const title = document.getElementById('about-notes-title');
  const list = document.getElementById('about-notes-list');
  const history = document.getElementById('about-notes-history');
  const releaseLink = document.getElementById('about-release-notes');
  if (!card || !title || !list) return;

  let releases: ReleaseSummary[] = [];
  try {
    const result = await window.api.getChangelog();
    if (Array.isArray(result?.releases)) releases = result.releases;
  } catch {
    return; // offline: leave both hidden
  }
  const release = releases.find((r) => r.version === version);
  const highlights = releaseHighlights(release?.body);

  if (highlights.length > 0) {
    title.textContent = `Novedades de ${version}`;
    list.innerHTML = renderMarkdown(
      highlights.map((item) => `- ${item}`).join('\n'),
    );
    card.hidden = false;
    list.addEventListener('click', (event) => {
      const href = closestElement(event.target, '[data-href]')?.dataset.href;
      if (!href) return;
      event.preventDefault();
      void window.api.openExternal(href);
    });
    history?.addEventListener('click', () => void openChangelog(version));
  }

  const url = release?.url;
  if (releaseLink && url) {
    releaseLink.hidden = false;
    releaseLink.addEventListener(
      'click',
      () => void window.api.openExternal(url),
    );
  }
}
