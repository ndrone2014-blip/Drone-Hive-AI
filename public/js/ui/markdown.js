import { escapeHtml } from './dom.js';
import { icon } from './icons.js';

/**
 * Small, safe Markdown renderer for AI replies (no dependencies).
 * All text is HTML-escaped first; only a known set of Markdown features is
 * turned back into HTML. Links are limited to http(s) and mailto.
 *
 * Supports: fenced code blocks, inline code, headings, bold, italic,
 * strikethrough, links, ordered/unordered lists, blockquotes, horizontal
 * rules, tables (simple), paragraphs and line breaks.
 */
export function renderMarkdown(src) {
  const text = String(src || '').replace(/\r\n?/g, '\n');
  const blocks = [];

  // 1. Pull out fenced code blocks so nothing inside them is touched.
  const withoutCode = text.replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    blocks.push(codeBlock(code.replace(/\n$/, ''), lang));
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const lines = withoutCode.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // code block placeholder
    const ph = line.match(/^\u0000(\d+)\u0000$/);
    if (ph) {
      out.push(blocks[Number(ph[1])]);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 1, 5); // h2..h5 inside a message
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    // hr
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // blockquote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const rows = [];
      const header = splitRow(line);
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(
        `<div class="md-table"><table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    // lists
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[2]) === ordered) {
          items.push({ indent: m[1].length, text: m[3] });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? Number.parseInt(listMatch[2], 10) : 1;
      out.push(
        `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items
          .map((it) => `<li${it.indent >= 2 ? ' class="md-nested"' : ''}>${inline(it.text).replace(/\n/g, '<br>')}</li>`)
          .join('')}</${tag}>`,
      );
      continue;
    }
    // paragraph
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\u0000\d+\u0000$/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    if (buf.length) out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    else i++;
  }

  return out.join('');
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function inline(raw) {
  const codes = [];
  let s = escapeHtml(raw).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });
  s = s
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, n) => codes[Number(n)]);
}

function codeBlock(code, lang) {
  const label = escapeHtml(lang || 'code');
  return `<div class="code-block"><div class="code-head"><span>${label}</span><button type="button" class="code-copy" data-action="copy-code" aria-label="Copy code">${icon('copy', { size: 14 })}<span>Copy</span></button></div><pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code)}</code></pre></div>`;
}
