import { describe, it, expect } from 'vitest';
import changelogView from '../renderer/changelog-view.js';

const { buildReleasesHtml } = changelogView;

// Stub deps: identity markdown + a real escaper so we can assert escaping.
const deps = {
  renderMarkdown: (b) => `<md>${b}</md>`,
  escapeHtml: (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};

const releases = [
  {
    version: '0.4.0',
    body: 'latest',
    url: 'https://x/40',
    publishedAt: '2026-08-05T00:00:00Z',
  },
  {
    version: '0.3.1',
    body: 'older',
    url: 'https://x/31',
    publishedAt: '2026-08-04T00:00:00Z',
  },
  { version: '0.2.0', body: 'oldest', url: '', prerelease: true },
];

describe('buildReleasesHtml', () => {
  it('opens ONLY the latest (first) release by default', () => {
    const html = buildReleasesHtml(releases, '0.3.1', deps);
    const panels = html.match(/<details class="cl-release"[^>]*>/g);
    expect(panels).toHaveLength(3);
    expect(panels[0]).toContain(' open');
    expect(panels[1]).not.toContain(' open');
    expect(panels[2]).not.toContain(' open');
  });

  it('renders a "Ver release" link per version pointing at its url', () => {
    const html = buildReleasesHtml(releases, '0.3.1', deps);
    expect(html).toContain('data-href="https://x/40"');
    expect(html).toContain('data-href="https://x/31"');
    // No url → no release link for that panel.
    expect(html).not.toContain('data-href=""');
    expect(html.match(/cl-rel-link/g)).toHaveLength(2);
  });

  it('flags the installed version and prereleases', () => {
    const html = buildReleasesHtml(releases, '0.3.1', deps);
    const installed = html.match(/instalada/g);
    expect(installed).toHaveLength(1); // only 0.3.1
    expect(html).toContain('pre-release'); // 0.2.0
  });

  it('escapes version and url', () => {
    const html = buildReleasesHtml(
      [{ version: '<b>', body: 'x', url: 'https://x/"<' }],
      '',
      deps,
    );
    expect(html).toContain('v&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('is deterministic — same input yields identical output (idempotent)', () => {
    expect(buildReleasesHtml(releases, '0.4.0', deps)).toBe(
      buildReleasesHtml(releases, '0.4.0', deps),
    );
  });

  it('handles empty / invalid input', () => {
    expect(buildReleasesHtml([], '', deps)).toContain('cl-empty');
    expect(buildReleasesHtml(null, '', deps)).toContain('cl-empty');
  });
});
