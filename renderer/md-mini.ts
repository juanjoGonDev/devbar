const SENT = String.fromCharCode(0xe000);

export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"]/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
      })[char] ?? char,
  );
}

function inline(text: string): string {
  const links: string[] = [];
  const stash = (url: string, label: string): string => {
    const index = links.push(`<a data-href="${url}" href="#">${label}</a>`) - 1;
    return `${SENT}${index}${SENT}`;
  };
  let out = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) =>
      stash(escapeHtml(url), escapeHtml(label)),
  );
  out = out.replace(/(https?:\/\/[^\s<]+)/g, (url) =>
    stash(escapeHtml(url), escapeHtml(url)),
  );
  out = escapeHtml(out)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return out.replace(
    new RegExp(`${SENT}(\\d+)${SENT}`, 'g'),
    (_match, index: string) => links[Number(index)] ?? '',
  );
}

export function renderMarkdown(source: unknown): string {
  const lines = String(source ?? '').split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (!inList) return;
    html.push('</ul>');
    inList = false;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^[*-]\s+(.*)$/);
    if (heading) {
      closeList();
      const marks = heading[1] ?? '#';
      const text = heading[2] ?? '';
      const level = Math.min(marks.length + 1, 6);
      html.push(`<h${level}>${inline(text)}</h${level}>`);
    } else if (bullet) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(bullet[1] ?? '')}</li>`);
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

const mdMini = { renderMarkdown, escapeHtml };
export default mdMini;
