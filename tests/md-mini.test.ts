import { describe, it, expect } from 'vitest';
import mdMini from '../renderer/md-mini.js';

const { renderMarkdown } = mdMini;

describe('renderMarkdown', () => {
  it('renders headings, bullets, bold and inline code', () => {
    const out = renderMarkdown(
      "## What's Changed\n* fixed **the** thing\n* run `npm test`",
    );
    expect(out).toContain("<h3>What's Changed</h3>");
    expect(out).toContain('<ul>');
    expect(out).toContain('<strong>the</strong>');
    expect(out).toContain('<code>npm test</code>');
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it('linkifies md links and bare URLs as data-href', () => {
    const out = renderMarkdown(
      'see [PR #38](https://github.com/o/r/pull/38) and https://x.dev/a',
    );
    expect(out).toContain('data-href="https://github.com/o/r/pull/38"');
    expect(out).toContain('href="#"'); // keyboard-focusable
    expect(out).toContain('PR #38</a>');
    expect(out).toContain('data-href="https://x.dev/a"');
    expect(out).toContain('>https://x.dev/a</a>');
  });

  it('escapes HTML so injected notes are safe', () => {
    const out = renderMarkdown('<script>alert(1)</script> & <b>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
  });

  it('does not corrupt loose numbers in text', () => {
    // A bare "3" must not be mistaken for a stashed-link placeholder.
    expect(renderMarkdown('bumped to version 3 today')).toContain(
      'version 3 today',
    );
  });

  it('tolerates empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
  });
});
