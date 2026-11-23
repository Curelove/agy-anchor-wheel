// Lightweight, XSS-safe Markdown & Code Renderer with clickable non-overwriting file links & line anchors
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const KNOWN_EXT_RE =
    /\.(?:md|mdx|txt|log|rst|json|jsonc|yaml|yml|toml|ini|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|lua|sh|bash|ps1|bat|cmd|sql|css|scss|less|html|htm|xml|svg|png|jpg|jpeg|webp|gif|mp4|webm|mov|mkv|mp3|wav|ogg|flac|m4a|srt|ass|pdf|csv|tsv)$/i;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isLocalTarget(href) {
    const s = String(href || '').trim();
    if (!s || s.startsWith('#')) return false;
    return !/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(s);
  }

  function renderInline(rawText, deadTargetSet) {
    let text = esc(rawText);

    // Inline code `...` — turn local file paths inside backticks into draggable file chips
    text = text.replace(/`([^`]+)`/g, (_m, inner) => {
      const clean = inner.trim();
      if (isLocalTarget(clean) && !/\s{2,}/.test(clean) && KNOWN_EXT_RE.test(clean.replace(/#L\d+(?:-L?\d+)?$/i, ''))) {
        const isDead = deadTargetSet?.has(clean);
        return `<a class="aw-md-file-chip" href="#" draggable="true" data-aw-link="${esc(clean)}" data-dead="${isDead ? '1' : '0'}">${clean}</a>`;
      }
      return `<code>${inner}</code>`;
    });

    // Standard Markdown links [label](href)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
      const cleanHref = href.trim();
      if (/^https?:\/\//i.test(cleanHref)) {
        return `<a class="aw-md-ext-link" href="${cleanHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      if (cleanHref.startsWith('#')) {
        return `<a class="aw-md-anchor-link" href="${cleanHref}">${label}</a>`;
      }
      const isDead = deadTargetSet?.has(cleanHref);
      return `<a class="aw-md-file-link" href="#" draggable="true" data-aw-link="${cleanHref}" data-dead="${isDead ? '1' : '0'}">${label}</a>`;
    });

    // Obsidian [[wikilink|alias]]
    text = text.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, target, _head, alias) => {
      const label = alias || target;
      return `<a class="aw-md-file-link" href="#" draggable="true" data-aw-link="${target.trim()}">${label}</a>`;
    });

    // Bold & Italic
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return text;
  }

  function renderMarkdown(markdownText, opts = {}) {
    const lines = String(markdownText || '').split(/\r?\n/);
    const deadSet = opts.deadSet || null;
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const lineNo = i + 1;

      // Fenced code block
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2].trim();
        const codeLines = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        out.push(
          `<div class="aw-md-codewrap" data-aw-line="${lineNo}"><div class="aw-md-codehead"><span>${esc(lang || 'text')}</span><button type="button" class="aw-md-copy-btn" data-aw-copy-code="1">复制</button></div><pre><code>${esc(codeLines.join('\n'))}</code></pre></div>`
        );
        continue;
      }

      // Blank line
      if (!line.trim()) {
        i++;
        continue;
      }

      // Headings
      const h = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (h) {
        const level = h[1].length;
        out.push(`<h${level} data-aw-line="${lineNo}">${renderInline(h[2], deadSet)}</h${level}>`);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        out.push('<hr/>');
        i++;
        continue;
      }

      // GFM Table
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        const splitCells = (row) =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
        const headers = splitCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push({ lineNo: i + 1, cells: splitCells(lines[i]) });
          i++;
        }
        const thead = `<thead><tr>${headers.map((c) => `<th>${renderInline(c, deadSet)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${rows
          .map((r) => `<tr data-aw-line="${r.lineNo}">${r.cells.map((c) => `<td>${renderInline(c, deadSet)}</td>`).join('')}</tr>`)
          .join('')}</tbody>`;
        out.push(`<div class="aw-md-tablewrap"><table>${thead}${tbody}</table></div>`);
        continue;
      }

      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        const qLines = [];
        const startLine = lineNo;
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          qLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote data-aw-line="${startLine}">${qLines.map((l) => renderInline(l, deadSet)).join('<br/>')}</blockquote>`);
        continue;
      }

      // Unordered / Ordered list
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
        const isOrdered = /^\s*\d+\./.test(line);
        const tag = isOrdered ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
          const itemLine = i + 1;
          const body = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
          const taskMatch = /^\[( |x|X)\]\s+(.*)$/.exec(body);
          if (taskMatch) {
            const checked = taskMatch[1].toLowerCase() === 'x';
            items.push(
              `<li data-aw-line="${itemLine}"><span class="aw-task-box" data-checked="${checked ? '1' : '0'}">${checked ? '✓' : ''}</span>${renderInline(taskMatch[2], deadSet)}</li>`
            );
          } else {
            items.push(`<li data-aw-line="${itemLine}">${renderInline(body, deadSet)}</li>`);
          }
          i++;
        }
        out.push(`<${tag}>${items.join('')}</${tag}>`);
        continue;
      }

      // Paragraph
      const pLines = [];
      const pStart = lineNo;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(?:#{1,6}\s+|`{3,}|~{3,}|>\s?|[-*+]\s+|\d+\.\s+|---+|\*\*\*+)/.test(lines[i])
      ) {
        pLines.push(lines[i]);
        i++;
      }
      out.push(`<p data-aw-line="${pStart}">${pLines.map((l) => renderInline(l, deadSet)).join('<br/>')}</p>`);
    }

    return out.join('\n');
  }

  function renderCodeLines(text, highlightStart, highlightEnd) {
    const lines = String(text || '').split(/\r?\n/);
    return `<div class="aw-code-lines">${lines
      .map((l, idx) => {
        const ln = idx + 1;
        const hl = highlightStart && ln >= highlightStart && ln <= (highlightEnd || highlightStart);
        return `<div class="aw-code-row" data-aw-line="${ln}" data-hl="${hl ? '1' : '0'}"><span class="aw-code-ln">${ln}</span><span class="aw-code-txt">${esc(l) || ' '}</span></div>`;
      })
      .join('')}</div>`;
  }

  return { renderMarkdown, renderCodeLines, esc };
});
