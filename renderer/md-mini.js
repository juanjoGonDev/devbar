'use strict';

/**
 * md-mini.js — tiny Markdown to HTML for GitHub release notes. Not a full
 * CommonMark parser: handles headings, bullet lists, bold, inline code, and
 * links (both [text](url) and bare URLs). Everything is HTML-escaped first, so
 * the output is safe to inject with innerHTML. Links become
 * <a data-href="..."> and the page routes clicks through the OS browser.
 *
 * ponytail: covers what release bodies actually use. Add a real parser only if
 * we start rendering arbitrary Markdown.
 *
 * Dual-use: window.mdMini in the renderer, module.exports in Node for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.mdMini = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Private-use char: absent from real text, survives escapeHtml, so it safely
  // marks where a rendered link should be re-inserted.
  const SENT = String.fromCharCode(0xe000);

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  }

  function inline(text) {
    const links = [];
    const stash = (url, label) => {
      const i = links.push(`<a data-href="${url}">${label}</a>`) - 1;
      return `${SENT}${i}${SENT}`;
    };
    // [text](url) first, then bare URLs, so we never re-link inside an href.
    let out = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, label, url) => stash(escapeHtml(url), escapeHtml(label)),
    );
    out = out.replace(/(https?:\/\/[^\s<]+)/g, (url) =>
      stash(escapeHtml(url), escapeHtml(url)),
    );
    // Escape the surviving plain text, then apply the safe inline markup.
    out = escapeHtml(out)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    // Restore stashed links.
    return out.replace(
      new RegExp(`${SENT}(\\d+)${SENT}`, 'g'),
      (_m, i) => links[Number(i)],
    );
  }

  function renderMarkdown(src) {
    const lines = String(src || '').split(/\r?\n/);
    const html = [];
    let inList = false;
    const closeList = () => {
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^[*-]\s+(.*)$/);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 6); // # to h2, keep small
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet) {
        if (!inList) {
          html.push('<ul>');
          inList = true;
        }
        html.push(`<li>${inline(bullet[1])}</li>`);
      } else if (line === '') {
        closeList();
      } else {
        closeList();
        html.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return html.join('\n');
  }

  return { renderMarkdown, escapeHtml };
});
