'use strict';

/**
 * changelog-view.js — pure rendering for the changelog accordion. Each release
 * is a native <details> panel; only the first (latest) is open by default.
 * Kept dependency-free (markdown + escape are injected) so it's unit-testable
 * in Node — see tests/changelog-view.test.js.
 *
 * Dual-use: window.changelogView in the renderer, module.exports in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.changelogView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * @param releases  [{version, body, url, publishedAt, prerelease}]
   * @param current   installed version string (flagged "instalada")
   * @param deps      { renderMarkdown(body)->html, escapeHtml(s)->s }
   */
  function buildReleasesHtml(releases, current, deps) {
    const renderMarkdown = deps.renderMarkdown;
    const escapeHtml = deps.escapeHtml;
    if (!Array.isArray(releases) || releases.length === 0) {
      return '<p class="cl-empty">No se pudieron cargar las versiones.</p>';
    }
    return releases
      .map((r, i) => {
        const isCurrent = r.version === current;
        const date = r.publishedAt
          ? escapeHtml(r.publishedAt.slice(0, 10))
          : '';
        const notes = renderMarkdown(r.body || '_Sin notas._');
        const v = escapeHtml(r.version);
        const releaseBtn = r.url
          ? `<a class="small-btn cl-rel-link" href="#" data-href="${escapeHtml(r.url)}">Ver release ↗</a>`
          : '';
        // Only the latest (first) release is expanded by default.
        return `
          <details class="cl-release"${i === 0 ? ' open' : ''}>
            <summary class="cl-rel-summary">
              <span class="cl-version">v${v}</span>
              ${isCurrent ? '<span class="cl-tag">instalada</span>' : ''}
              ${r.prerelease ? '<span class="cl-tag pre">pre-release</span>' : ''}
              ${date ? `<span class="cl-date">${date}</span>` : ''}
            </summary>
            <div class="cl-notes">${notes}</div>
            ${releaseBtn ? `<div class="cl-rel-actions">${releaseBtn}</div>` : ''}
          </details>`;
      })
      .join('');
  }

  return { buildReleasesHtml };
});
