'use strict';

// Render GitHub Markdown into safe DOM nodes, never innerHTML.
function renderMergeMarkdown(root, markdown, { baseUrl, openLink, mapLink } = {}) {
  const doc = root.ownerDocument;
  const TICK = String.fromCharCode(96);
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  function node(parent, tag, text) {
    const child = doc.createElement(tag);
    if (text !== undefined) child.textContent = text;
    parent.appendChild(child);
    return child;
  }
  function safeUrl(value) {
    try {
      const url = new URL(value.trim(), baseUrl || 'https://github.com/');
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  // Only GitHub-hosted attachments are allowed to load automatically in this webview.
  // Untrusted Markdown images stay clickable links instead of making remote requests.
  function safeImageUrl(value) {
    const href = safeUrl(value || '');
    if (!href) return null;
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.port) return null;
    if (url.hostname === 'github.com' && /^\/user-attachments\/assets\/[a-z0-9-]+\/?$/i.test(url.pathname)) return href;
    if (url.hostname === 'user-images.githubusercontent.com' && /^\/\d+\//.test(url.pathname)) return href;
    return null;
  }
  function addImage(parent, label, value) {
    const src = safeImageUrl(value);
    if (!src) return false;
    const img = node(parent, 'img');
    img.src = src;
    img.alt = label || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    return true;
  }
  function addLink(parent, label, value, renderChild) {
    const url = safeUrl(value);
    if (!url) return false;
    const a = node(parent, 'a', renderChild ? undefined : label);
    if (renderChild) renderChild(a);
    a.href = typeof mapLink === 'function' ? safeUrl(mapLink(url)) || url : url;
    a.rel = 'noopener noreferrer';
    if (typeof openLink === 'function') {
      a.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openLink(a.href);
      });
    } else a.target = '_blank';
    return true;
  }
  function markdownLink(source, start) {
    const close = source.indexOf(']', start + 1);
    if (close < 0) return null;
    // Generated research sometimes writes [label] (https://source).
    let begin = close + 1;
    while (begin < source.length && /\s/.test(source[begin])) begin++;
    if (source[begin] !== '(') return null;
    let i = begin + 1, nested = 1;
    while (i < source.length && nested) {
      if (source[i] === '(') nested++;
      if (source[i] === ')') nested--;
      i++;
    }
    if (nested) return null;
    let url = source.slice(begin + 1, i - 1).trim().replace(/\s+["'][^"']*["']$/, '');
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
    return { label: source.slice(start + 1, close), url, end: i };
  }
  function htmlAttributes(text) {
    const values = {};
    const pattern = /([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let match;
    while ((match = pattern.exec(text))) values[match[1].toLowerCase()] = match[2] ?? match[3];
    return values;
  }
  // GitHub PR descriptions often contain centered linked image banners. Recognize
  // only these image shapes, never parse or inject arbitrary source HTML.
  function htmlImage(text) {
    let offset = 0, centered = false, href = null;
    const paragraph = /^<p\b([^<>]*)>\s*/i.exec(text);
    if (paragraph) {
      centered = htmlAttributes(paragraph[1]).align === 'center';
      offset += paragraph[0].length;
    }
    const anchor = /^<a\b([^<>]*)>\s*/i.exec(text.slice(offset));
    if (anchor) {
      href = htmlAttributes(anchor[1]).href;
      offset += anchor[0].length;
    }
    const image = /^<img\b([^<>]*?)\s*\/?>/i.exec(text.slice(offset));
    if (!image) return null;
    const attrs = htmlAttributes(image[1]);
    if (!safeImageUrl(attrs.src)) return null;
    offset += image[0].length;
    if (anchor) {
      const close = /^\s*<\/a\s*>/i.exec(text.slice(offset));
      if (!close) return null;
      offset += close[0].length;
    }
    if (paragraph) {
      const close = /^\s*<\/p\s*>/i.exec(text.slice(offset));
      if (!close) return null;
      offset += close[0].length;
    }
    return { src: attrs.src, alt: attrs.alt || '', href, centered, end: offset };
  }
  function addHtmlImage(parent, image) {
    const container = image.centered ? node(parent, 'span') : parent;
    if (image.centered) container.className = 'markdown-image-center';
    if (!image.href || !addLink(container, image.alt, image.href,
      anchor => addImage(anchor, image.alt, image.src))) addImage(container, image.alt, image.src);
  }
  function inline(parent, text, level = 0) {
    if (level > 10) { node(parent, 'span', text); return; }
    let pending = '', i = 0;
    const flush = () => { if (pending) node(parent, 'span', pending); pending = ''; };
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) { pending += text[i + 1]; i += 2; continue; }
      const isImage = ch === '!' && text[i + 1] === '[';
      const linkStart = isImage ? i + 1 : i;
      if (text[linkStart] === '[') {
        const match = markdownLink(text, linkStart);
        if (match && safeUrl(match.url)) {
          flush();
          if (isImage && safeImageUrl(match.url)) addImage(parent, match.label, match.url);
          else addLink(parent, (isImage ? 'Image: ' : '') + match.label, match.url);
          i = match.end;
          continue;
        }
      }
      if (ch === TICK) {
        let len = 1;
        while (text[i + len] === TICK) len++;
        const end = text.indexOf(TICK.repeat(len), i + len);
        if (end >= 0) { flush(); node(parent, 'code', text.slice(i + len, end).replace(/\n/g, ' ')); i = end + len; continue; }
      }
      if (ch === '<') {
        const image = htmlImage(text.slice(i));
        if (image) {
          flush();
          addHtmlImage(parent, image);
          i += image.end;
          continue;
        }
        const end = text.indexOf('>', i + 1);
        const value = end < 0 ? '' : text.slice(i + 1, end);
        if (/^https?:\/\//i.test(value.trim()) && safeUrl(value)) { flush(); addLink(parent, value, value); i = end + 1; continue; }
      }
      const bare = /^https?:\/\/[^\s<>"']+/i.exec(text.slice(i));
      if (bare && (i === 0 || !/[\w/@]/.test(text[i - 1]))) {
        let value = bare[0].replace(/[.,;:!?]+$/, '');
        while (value.endsWith(')') && (value.match(/\)/g) || []).length > (value.match(/\(/g) || []).length) value = value.slice(0, -1);
        if (safeUrl(value)) { flush(); addLink(parent, value, value); i += value.length; continue; }
      }
      let matched = false;
      for (const [marker, tag, innerTag] of [
        ['***', 'strong', 'em'], ['___', 'strong', 'em'],
        ['**', 'strong'], ['__', 'strong'], ['~~', 's'], ['*', 'em'], ['_', 'em']
      ]) {
        if (!text.startsWith(marker, i)) continue;
        if (marker[0] === '_' && i > 0 && /\w/.test(text[i - 1])) continue;
        if (/\s/.test(text[i + marker.length] || '')) continue;
        let end = -1;
        for (let at = i + marker.length; at < text.length; at++) {
          if (text[at] === '\\') { at++; continue; }
          if (text[at] === TICK) {
            const tickEnd = text.indexOf(TICK, at + 1);
            if (tickEnd >= 0) { at = tickEnd; continue; }
          }
          if (!text.startsWith(marker, at)) continue;
          const ch = marker[0];
          if (marker.length === 1 && (text[at - 1] === ch || text[at + 1] === ch)) continue;
          if (marker.length === 2 && text[at + 2] === ch) continue;
          if (/\s/.test(text[at - 1])) continue;
          if (ch === '_' && /\w/.test(text[at + marker.length] || '')) continue;
          end = at;
          break;
        }
        if (end < 0) continue;
        flush();
        const outer = node(parent, tag);
        const inner = innerTag ? node(outer, innerTag) : outer;
        inline(inner, text.slice(i + marker.length, end), level + 1);
        i = end + marker.length;
        matched = true;
        break;
      }
      if (matched) continue;
      pending += ch;
      i++;
    }
    flush();
  }
  function listItem(line) {
    const match = /^ {0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    return match ? { ordered: /^\d/.test(match[1]), text: match[2] } : null;
  }
  function fence(line) {
    const text = line.trimStart();
    if (/^~{3,}/.test(text)) return /^~+/.exec(text)[0];
    if (!text.startsWith(TICK.repeat(3))) return null;
    let i = 0;
    while (text[i] === TICK) i++;
    return TICK.repeat(i);
  }
  function blockStart(line) {
    return /^ {0,3}(?:#{1,6}\s+|>\s?|[-*_]{3,}\s*$)/.test(line) || Boolean(listItem(line)) || Boolean(fence(line));
  }
  function cells(value) { return value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(part => part.trim()); }
  function divider(value) { return value.includes('|') && cells(value).every(part => /^:?-{3,}:?$/.test(part)); }
  function blocks(parent, rows, depth = 0) {
    for (let i = 0; i < rows.length;) {
      const line = rows[i];
      if (!line.trim()) { i++; continue; }
      const marker = fence(line);
      if (marker) {
        const source = [];
        i++;
        while (i < rows.length && !rows[i].trimStart().startsWith(marker[0].repeat(marker.length))) source.push(rows[i++]);
        if (i < rows.length) i++;
        node(node(parent, 'pre'), 'code', source.join('\n'));
        continue;
      }
      const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { inline(node(parent, 'h' + heading[1].length), heading[2].replace(/\s+#+\s*$/, '')); i++; continue; }
      if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { node(parent, 'hr'); i++; continue; }
      if (i + 1 < rows.length && line.includes('|') && divider(rows[i + 1])) {
        const table = node(parent, 'table'), headings = node(node(table, 'thead'), 'tr');
        for (const value of cells(line)) inline(node(headings, 'th'), value);
        const tbody = node(table, 'tbody');
        i += 2;
        while (i < rows.length && rows[i].trim() && rows[i].includes('|')) {
          const tr = node(tbody, 'tr');
          for (const value of cells(rows[i++])) inline(node(tr, 'td'), value);
        }
        continue;
      }
      if (/^ {0,3}>\s?/.test(line)) {
        const quote = [];
        while (i < rows.length && /^ {0,3}>\s?/.test(rows[i])) quote.push(rows[i++].replace(/^ {0,3}>\s?/, ''));
        const block = node(parent, 'blockquote');
        if (depth < 4) blocks(block, quote, depth + 1);
        else node(block, 'p', quote.join(' '));
        continue;
      }
      const first = listItem(line);
      if (first) {
        const list = node(parent, first.ordered ? 'ol' : 'ul');
        while (i < rows.length) {
          const item = listItem(rows[i]);
          if (!item || first.ordered !== item.ordered) break;
          const li = node(list, 'li'), task = /^\[([ xX])\]\s+/.exec(item.text);
          if (task) {
            const input = node(li, 'input');
            input.type = 'checkbox';
            input.disabled = true;
            input.checked = task[1].toLowerCase() === 'x';
            inline(li, item.text.slice(task[0].length));
          } else inline(li, item.text);
          i++;
          while (i < rows.length && /^ {2,}\S/.test(rows[i]) && !listItem(rows[i])) {
            node(li, 'span', ' ');
            inline(li, rows[i++].trim());
          }
        }
        continue;
      }
      const paragraph = [line.trim()];
      i++;
      while (i < rows.length && rows[i].trim() && !blockStart(rows[i]) &&
          !(i + 1 < rows.length && rows[i].includes('|') && divider(rows[i + 1]))) paragraph.push(rows[i++].trim());
      inline(node(parent, 'p'), paragraph.join('\n'));
    }
  }
  blocks(root, lines);
}
if (typeof module === 'object' && module.exports) module.exports = { renderMergeMarkdown };
