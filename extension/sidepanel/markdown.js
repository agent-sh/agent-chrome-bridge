'use strict';

// Minimal safe markdown → DOM. Builds only text nodes and element nodes via
// createElement, never innerHTML, so untrusted input can't inject HTML.
// Supports: paragraphs, headings 1-4, fenced code, inline code, blockquotes,
// unordered and ordered lists, horizontal rules, bold, italic, links, bare urls.

(function () {
  const INLINE_TOKEN = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>()[\]]+)/g;

  function renderMarkdown(text) {
    const container = document.createElement('div');
    container.className = 'md';
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === '') { i++; continue; }

      // Fenced code.
      const fenceMatch = line.match(/^```(\w*)\s*$/);
      if (fenceMatch) {
        const lang = fenceMatch[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // consume closing fence
        const pre = document.createElement('pre');
        if (lang) pre.dataset.lang = lang;
        const code = document.createElement('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        container.appendChild(pre);
        continue;
      }

      // Heading.
      const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const heading = document.createElement(`h${level}`);
        renderInline(heading, headingMatch[2].trim());
        container.appendChild(heading);
        i++;
        continue;
      }

      // Horizontal rule.
      if (/^(?:\s*[-*_]){3,}\s*$/.test(line) && line.trim().replace(/[-*_\s]/g, '') === '') {
        container.appendChild(document.createElement('hr'));
        i++;
        continue;
      }

      // Blockquote.
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const bq = document.createElement('blockquote');
        renderInline(bq, buf.join('\n'));
        container.appendChild(bq);
        continue;
      }

      // Unordered list.
      if (/^\s*[-*+]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          renderInline(li, lines[i].replace(/^\s*[-*+]\s+/, ''));
          ul.appendChild(li);
          i++;
        }
        container.appendChild(ul);
        continue;
      }

      // Ordered list.
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          renderInline(li, lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          ol.appendChild(li);
          i++;
        }
        container.appendChild(ol);
        continue;
      }

      // Paragraph — collect until blank line or block boundary.
      const buf = [line];
      i++;
      while (i < lines.length
          && lines[i].trim() !== ''
          && !/^```/.test(lines[i])
          && !/^#{1,4}\s/.test(lines[i])
          && !/^\s*>\s?/.test(lines[i])
          && !/^\s*[-*+]\s+/.test(lines[i])
          && !/^\s*\d+[.)]\s+/.test(lines[i])
          && !(/^(?:\s*[-*_]){3,}\s*$/.test(lines[i]) && lines[i].trim().replace(/[-*_\s]/g, '') === '')) {
        buf.push(lines[i]);
        i++;
      }
      const p = document.createElement('p');
      renderInline(p, buf.join('\n'));
      container.appendChild(p);
    }

    return container;
  }

  function renderInline(parent, text) {
    // Tokenize by inline patterns; push literal text + styled spans.
    let lastIndex = 0;
    const str = String(text);
    INLINE_TOKEN.lastIndex = 0;
    let match;
    while ((match = INLINE_TOKEN.exec(str)) !== null) {
      if (match.index > lastIndex) {
        appendText(parent, str.slice(lastIndex, match.index));
      }
      const token = match[0];
      appendInline(parent, token);
      lastIndex = match.index + token.length;
    }
    if (lastIndex < str.length) {
      appendText(parent, str.slice(lastIndex));
    }
  }

  function appendText(parent, s) {
    // Preserve single newlines inside a paragraph as <br>.
    const parts = s.split('\n');
    parts.forEach((part, idx) => {
      if (part.length) parent.appendChild(document.createTextNode(part));
      if (idx < parts.length - 1) parent.appendChild(document.createElement('br'));
    });
  }

  function appendInline(parent, token) {
    if (token.startsWith('**') && token.endsWith('**')) {
      const el = document.createElement('strong');
      renderInline(el, token.slice(2, -2));
      parent.appendChild(el);
      return;
    }
    if (token.startsWith('__') && token.endsWith('__')) {
      const el = document.createElement('strong');
      renderInline(el, token.slice(2, -2));
      parent.appendChild(el);
      return;
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      const el = document.createElement('code');
      el.textContent = token.slice(1, -1);
      parent.appendChild(el);
      return;
    }
    if (token.startsWith('*') && token.endsWith('*')) {
      const el = document.createElement('em');
      renderInline(el, token.slice(1, -1));
      parent.appendChild(el);
      return;
    }
    if (token.startsWith('_') && token.endsWith('_')) {
      const el = document.createElement('em');
      renderInline(el, token.slice(1, -1));
      parent.appendChild(el);
      return;
    }
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const a = document.createElement('a');
      a.textContent = linkMatch[1];
      a.href = safeUrl(linkMatch[2]);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
      return;
    }
    if (/^https?:\/\//.test(token)) {
      const a = document.createElement('a');
      a.textContent = token;
      a.href = safeUrl(token);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
      return;
    }
    appendText(parent, token);
  }

  function safeUrl(url) {
    const lower = String(url).trim().toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
      return '#';
    }
    return url;
  }

  function stripMarkdown(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/^```\w*\s*/m, '').replace(/```$/m, ''))
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,4}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '');
  }

  globalThis.__agentChromeBridgeMarkdown = { renderMarkdown, stripMarkdown };
})();
