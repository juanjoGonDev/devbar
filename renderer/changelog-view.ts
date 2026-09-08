export interface ChangelogRelease {
  version: string;
  body?: string;
  url?: string;
  publishedAt?: string;
  prerelease?: boolean;
}
interface RenderDeps {
  renderMarkdown(source: unknown): string;
  escapeHtml(value: unknown): string;
}

export function buildReleasesHtml(
  releases: readonly ChangelogRelease[] | null | undefined,
  current: string,
  deps: RenderDeps,
): string {
  if (!releases || releases.length === 0)
    return '<p class="cl-empty">No se pudieron cargar las versiones.</p>';
  return releases
    .map((release, index) => {
      const date = release.publishedAt
        ? deps.escapeHtml(release.publishedAt.slice(0, 10))
        : '';
      const notes = deps.renderMarkdown(release.body || '_Sin notas._');
      const version = deps.escapeHtml(release.version);
      const releaseButton = release.url
        ? `<a class="small-btn cl-rel-link" href="#" data-href="${deps.escapeHtml(release.url)}">Ver release ↗</a>`
        : '';
      return `
          <details class="cl-release"${index === 0 ? ' open' : ''}>
            <summary class="cl-rel-summary">
              <span class="cl-version">v${version}</span>
              ${release.version === current ? '<span class="cl-tag">instalada</span>' : ''}
              ${release.prerelease ? '<span class="cl-tag pre">pre-release</span>' : ''}
              ${date ? `<span class="cl-date">${date}</span>` : ''}
            </summary>
            <div class="cl-notes">${notes}</div>
            ${releaseButton ? `<div class="cl-rel-actions">${releaseButton}</div>` : ''}
          </details>`;
    })
    .join('');
}
const changelogView = { buildReleasesHtml };
export default changelogView;
