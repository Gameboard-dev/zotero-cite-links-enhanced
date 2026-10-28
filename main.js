'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, Platform } = require('obsidian');
const { Decoration, ViewPlugin } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');
const { syntaxTree, tokenClassNodeProp } = require('@codemirror/language');
const http = require('http');

const CITE_RX = /(?<![A-Za-z0-9_@.])@([A-Za-z][A-Za-z0-9_:.\-]*[A-Za-z0-9])/g;
const LOCATOR_RX = /^\s*,\s*(?:pp?\.\s*)?(\d+)(?![\d:])/;
const IGNORE_TOKENS = /code|math|templater|hashtag/;
const BBT_PATH = '/better-bibtex/json-rpc';
const RPC_TIMEOUT_MS = 2000;
// An export can take Zotero longer than a lookup.
const EXPORT_TIMEOUT_MS = 10000;
const EXPORT_TRANSLATOR = 'Better BibLaTeX';
// How long a citation pop-up stays after the pointer leaves its citation (or the modifier is released), so that the
// pointer can cross to it; inside the pop-up it stays until the pointer leaves.
const POPUP_GRACE_MS = 600;

const DEFAULT_SETTINGS = {
  zoteroPort: 23119,
  modifier: 'mod',
  hoverPopup: true,
};

// Node `http` is used (not Obsidian's `requestUrl`) because Better BibTeX's
// JSON-RPC endpoint closes the connection with ERR_EMPTY_RESPONSE when called
// via Electron's `net` module — a known incompatibility with `requestUrl`.
// This plugin is desktop-only, so Node modules are available.
// Resolves to { result } or { error } when Better BibTeX answered, and to { down: true } when nothing answered on the
// port (Zotero not running, Better BibTeX missing, or a timeout).
function bbtCall(port, method, params, timeout = RPC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: BBT_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
        },
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let reply;
          try { reply = JSON.parse(data); }
          catch { resolve({ down: true }); return; }
          if (reply && reply.error) resolve({ error: reply.error });
          else resolve({ result: reply ? reply.result : null });
        });
      }
    );
    req.on('error', () => resolve({ down: true }));
    req.on('timeout', () => { req.destroy(); resolve({ down: true }); });
    req.write(body);
    req.end();
  });
}

async function bbtRpc(port, method, params) {
  const r = await bbtCall(port, method, params);
  return r.result === undefined ? null : r.result;
}

// ---- BibTeX parsing (citation pop-ups) ----

// The index of the bracket that closes the one at `open` (`{` or `(`), or -1. Braces are counted; a character after a
// backslash (`\{`, `\}`) is not.
function bibClose(text, open) {
  const paren = text[open] === '(';
  let depth = paren ? 0 : 1;
  for (let j = open + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) return -1;
      if (!paren && depth === 0) return j;
    } else if (paren && c === ')' && depth === 0) return j;
  }
  return -1;
}

// The entries of a .bib text, by citation key: each `@type{key, ...}` block as written. @comment, @string and
// @preamble blocks are skipped.
function bibEntries(text) {
  const out = new Map();
  const head = /@\s*([A-Za-z]+)\s*([{(])/y;
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    head.lastIndex = at;
    const m = head.exec(text);
    if (!m) { i = at + 1; continue; }
    const open = head.lastIndex - 1;
    const end = bibClose(text, open);
    if (end < 0) { i = at + 1; continue; }
    const type = m[1].toLowerCase();
    if (type !== 'comment' && type !== 'string' && type !== 'preamble') {
      const body = text.slice(open + 1, end);
      const comma = body.indexOf(',');
      const key = (comma < 0 ? body : body.slice(0, comma)).trim();
      if (key) out.set(key, text.slice(at, end + 1));
    }
    i = end + 1;
  }
  return out;
}

// A field's value for reading: braces dropped (`{{AI}} Benchmark` → `AI Benchmark`), the common escapes undone
// (`\&` → `&`), white space collapsed.
function bibClean(value) {
  let out = '';
  for (let j = 0; j < value.length; j++) {
    const c = value[j];
    if (c === '\\' && j + 1 < value.length && '&%_#${}'.includes(value[j + 1])) { out += value[++j]; continue; }
    if (c === '{' || c === '}') continue;
    out += c;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// An entry's type, key and fields ([name, value] in the entry's order), or null when it is not `@type{key, ...}`.
// A value may be braced, quoted or bare, and parts joined with `#` are joined.
function bibFields(entry) {
  const m = /^@\s*([A-Za-z]+)\s*[{(]\s*([^,\s]*)\s*,?/.exec(entry);
  if (!m) return null;
  const fields = [];
  const name = /\s*([A-Za-z0-9_\-:.+]+)\s*=\s*/y;
  const bare = /[^\s,#})]+/y;
  const ws = /\s*/y;
  const skipWs = (k) => { ws.lastIndex = k; ws.exec(entry); return ws.lastIndex; };
  let i = m[0].length;
  const last = entry.length - 1;
  while (i < last) {
    name.lastIndex = i;
    const f = name.exec(entry);
    if (!f) break;
    i = name.lastIndex;
    const parts = [];
    for (;;) {
      const c = entry[i];
      if (c === '{') {
        const e = bibClose(entry, i);
        if (e < 0) return { type: m[1].toLowerCase(), key: m[2], fields };
        parts.push(entry.slice(i + 1, e));
        i = e + 1;
      } else if (c === '"') {
        let depth = 0;
        let j = i + 1;
        for (; j < entry.length; j++) {
          const d = entry[j];
          if (d === '\\') { j++; continue; }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          else if (d === '"' && depth === 0) break;
        }
        parts.push(entry.slice(i + 1, j));
        i = j + 1;
      } else {
        bare.lastIndex = i;
        const b = bare.exec(entry);
        if (!b) break;
        parts.push(b[0]);
        i = bare.lastIndex;
      }
      i = skipWs(i);
      if (entry[i] !== '#') break;
      i = skipWs(i + 1);
    }
    fields.push([f[1], bibClean(parts.join(''))]);
    i = skipWs(i);
    if (entry[i] === ',') i++;
  }
  return { type: m[1].toLowerCase(), key: m[2], fields };
}

// What `item.export` returned: the text (older Better BibTeX versions wrapped it as [status, type, text]).
function exportText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    for (let j = result.length - 1; j >= 0; j--) if (typeof result[j] === 'string') return result[j];
  }
  return '';
}

// ---- end of BibTeX parsing ----

function computePageParam(annotations, requestedPage) {
  if (!requestedPage) return null;
  const n = Number(requestedPage);
  if (!Number.isFinite(n)) return null;
  if (!Array.isArray(annotations) || annotations.length === 0) {
    return String(requestedPage);
  }
  const labelToIdx = new Map();
  let maxIdx = -1;
  for (const a of annotations) {
    const label = a && a.annotationPageLabel;
    const idx = a && a.annotationPosition && a.annotationPosition.pageIndex;
    if (label != null && typeof idx === 'number') {
      labelToIdx.set(String(label), idx);
      if (idx > maxIdx) maxIdx = idx;
    }
  }
  const exact = labelToIdx.get(String(requestedPage));
  if (typeof exact === 'number') return String(exact + 1);
  if (maxIdx >= 0 && n > maxIdx + 1) return '1';
  return String(requestedPage);
}

// Local change (2026-10-23): a locator is the page number printed in the source. Zotero's open-pdf `page` parameter is the PDF's
// page (pageIndex + 1), so the printed page is translated with the page markers of the paper's compiled note in this vault,
// `<!-- page 291 (310 / 360) -->` (printed label, then PDF page / pages). The note is found by its `zotero_pdf` property,
// which is the attachment's open-pdf address, or else by its `citekey`.
const PAGE_MARKER_RX = /<!--\s*page\s+([^\s(\/]+)\s*\(\s*(\d+)\s*\/\s*\d+\s*\)\s*-->/g;

function pdfPageFromMarkers(text, requestedPage) {
  PAGE_MARKER_RX.lastIndex = 0;
  let m;
  while ((m = PAGE_MARKER_RX.exec(text)) !== null) {
    if (m[1] === String(requestedPage)) return m[2];
  }
  return null;
}

function extractLocator(text, after) {
  const tail = text.slice(after, after + 80);
  const m = tail.match(LOCATOR_RX);
  return m ? m[1] : null;
}

function makeCmPlugin() {
  const citeMark = (citekey, page) => Decoration.mark({
    class: 'zcl-cite',
    attributes: page
      ? { 'data-citekey': citekey, 'data-page': page }
      : { 'data-citekey': citekey },
  });

  return ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = this.build(view); }
      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }
      build(view) {
        const b = new RangeSetBuilder();
        let tree;
        for (const { from, to } of view.visibleRanges) {
          const slice = view.state.sliceDoc(from, to);
          CITE_RX.lastIndex = 0;
          let m;
          while ((m = CITE_RX.exec(slice)) !== null) {
            const start = from + m.index;
            const end = start + m[0].length;
            if (!tree) tree = syntaxTree(view.state);
            const props = tree.resolveInner(start, 1).type.prop(tokenClassNodeProp);
            if (props && IGNORE_TOKENS.test(props)) continue;
            const page = extractLocator(slice, m.index + m[0].length);
            // Skip the leading '@' so only AuthorYYYY is decorated/underlined.
            b.add(start + 1, end, citeMark(m[1], page));
          }
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

module.exports = class ZoteroCiteLinks extends Plugin {
  libraryNames = ['My Library'];

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ZCLSettingTab(this.app, this));

    this.refreshLibraries();

    this.registerMarkdownPostProcessor((el) => this.processReadingMode(el));
    this.registerEditorExtension([makeCmPlugin()]);

    this.registerDomEvent(document, 'mousedown', this.onMouseDown, { capture: true });
    this.registerDomEvent(document, 'click', this.onClick, { capture: true });
    this.registerDomEvent(window, 'keydown', this.syncModClass);
    this.registerDomEvent(window, 'keyup', this.syncModClass);
    this.registerDomEvent(window, 'blur', this.clearModClass);
    this.syncModClass();

    // Citation pop-ups: Ctrl (Cmd on macOS) + hover shows the entry; Ctrl/Cmd+click still opens the PDF.
    this.bibVault = new Map();
    this.bibVaultSignature = null;
    this.bibVaultReading = null;
    this.bibFetched = new Map();
    this.bibPending = null;
    this.bibPopup = null;
    this.bibPopupKey = null;
    this.bibShown = '';
    this.bibLeaving = null;
    this.bibPointer = null;
    this.registerDomEvent(document, 'mousemove', this.onBibMouseMove);
    this.registerDomEvent(document, 'keydown', this.onBibKeyDown, { capture: true });
    this.registerDomEvent(document, 'keyup', this.onBibKeyUp);

    this.addCommand({
      id: 'open-at-cursor',
      name: 'Open citation at cursor in Zotero',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.openAtCursor(view);
        return true;
      },
    });

    this.addCommand({
      id: 'refresh-libraries',
      name: 'Refresh Zotero library list',
      callback: async () => {
        await this.refreshLibraries();
        new Notice(`zotero-cite-links: searching ${this.libraryNames.join(', ')}`);
      },
    });
  }

  onunload() {
    document.body.classList.remove('zcl-mod-held');
    this.hideBibPopup();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async refreshLibraries() {
    const groups = await bbtRpc(this.settings.zoteroPort, 'user.groups', []);
    if (Array.isArray(groups) && groups.length) {
      this.libraryNames = groups.map((g) => g.name).filter(Boolean);
    }
  }

  async findAttachment(citekey) {
    for (const lib of this.libraryNames) {
      const attachments = await bbtRpc(this.settings.zoteroPort, 'item.attachments', [citekey, lib]);
      if (Array.isArray(attachments)) {
        const withOpen = attachments.find((a) => a && a.open);
        if (withOpen) return withOpen;
      }
    }
    return null;
  }

  async findSelectUrl(citekey) {
    for (const lib of this.libraryNames) {
      const results = await bbtRpc(this.settings.zoteroPort, 'item.search', [citekey, lib]);
      if (!Array.isArray(results) || results.length === 0) continue;
      const exact = results.find((r) => (r && (r['citation-key'] || r.citekey)) === citekey);
      const r = exact || results[0];
      const id = (r && r.id) || '';
      const groupMatch = id.match(/groups\/(\d+)\/items\/([A-Z0-9]+)/);
      if (groupMatch) return `zotero://select/groups/${groupMatch[1]}/items/${groupMatch[2]}`;
      const userMatch = id.match(/users\/\d+\/items\/([A-Z0-9]+)/);
      if (userMatch) return `zotero://select/library/items/${userMatch[1]}`;
    }
    return null;
  }

  async resolveOpenUrl(citekey) {
    let attachment = await this.findAttachment(citekey);
    if (!attachment) {
      await this.refreshLibraries();
      attachment = await this.findAttachment(citekey);
    }
    if (attachment) {
      return { openUrl: attachment.open, annotations: attachment.annotations || [] };
    }
    let selectUrl = await this.findSelectUrl(citekey);
    if (!selectUrl) selectUrl = `zotero://select/items/@${citekey}`;
    return { openUrl: selectUrl, annotations: null };
  }

  findNote(openUrl, citekey) {
    const wantedAtt = (openUrl.match(/items\/([A-Z0-9]+)/) || [])[1];
    let byKey = null;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const pdf = typeof fm.zotero_pdf === 'string' ? fm.zotero_pdf : '';
      if (wantedAtt && pdf.endsWith(`/items/${wantedAtt}`)) return file;
      if (!byKey && fm.citekey === citekey) byKey = file;
    }
    return byKey;
  }

  async pageFromNote(openUrl, citekey, page) {
    if (!page) return null;
    const file = this.findNote(openUrl, citekey);
    if (!file) return null;
    try {
      return pdfPageFromMarkers(await this.app.vault.cachedRead(file), page);
    } catch {
      return null;
    }
  }

  async openCitation(citekey, page) {
    if (!citekey) return;
    const { openUrl, annotations } = await this.resolveOpenUrl(citekey);
    let finalUrl = openUrl;
    if (openUrl.includes('open-pdf')) {
      const pageParam = (await this.pageFromNote(openUrl, citekey, page)) || computePageParam(annotations, page);
      if (pageParam) finalUrl = `${openUrl}?page=${pageParam}`;
    }
    window.open(finalUrl);
  }

  processReadingMode(rootEl) {
    const walker = rootEl.doc.createNodeIterator(rootEl, NodeFilter.SHOW_TEXT);
    const toReplace = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      const tag = parent.tagName;
      if (tag === 'CODE' || tag === 'PRE' || tag === 'A') continue;
      const text = node.nodeValue;
      if (!text || text.indexOf('@') < 0) continue;
      CITE_RX.lastIndex = 0;
      if (!CITE_RX.test(text)) continue;
      toReplace.push(node);
    }
    for (const node of toReplace) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      CITE_RX.lastIndex = 0;
      let m;
      while ((m = CITE_RX.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
        const page = extractLocator(text, end);
        // Keep the '@' outside the styled/clickable span so only AuthorYYYY
        // gets the underline.
        frag.appendChild(document.createTextNode('@'));
        const span = document.createElement('span');
        span.className = 'zcl-cite';
        span.dataset.citekey = m[1];
        if (page) span.dataset.page = page;
        span.textContent = m[1];
        frag.appendChild(span);
        last = end;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  isOpenModifier(evt) {
    if (this.settings.modifier === 'none') return true;
    return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
  }

  syncModClass = (evt) => {
    const held = this.settings.modifier === 'none' || (evt && this.isOpenModifier(evt));
    document.body.classList.toggle('zcl-mod-held', held);
  };

  clearModClass = () => {
    document.body.classList.toggle('zcl-mod-held', this.settings.modifier === 'none');
  };

  hitFromTarget(target) {
    if (!(target instanceof Element)) return null;
    const el = target.closest('.zcl-cite[data-citekey]');
    if (!el) return null;
    const key = el.getAttribute('data-citekey');
    const page = el.getAttribute('data-page') || null;
    return key ? { key, page } : null;
  }

  onMouseDown = (evt) => {
    if (evt.button !== 0) return;
    if (!this.isOpenModifier(evt)) return;
    if (!this.hitFromTarget(evt.target)) return;
    evt.preventDefault();
    evt.stopPropagation();
  };

  onClick = (evt) => {
    if (evt.button !== 0) return;
    if (!this.isOpenModifier(evt)) return;
    const hit = this.hitFromTarget(evt.target);
    if (!hit) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.openCitation(hit.key, hit.page);
  };

  openAtCursor(view) {
    const editor = view.editor;
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    CITE_RX.lastIndex = 0;
    let m;
    let chosen = null;
    while ((m = CITE_RX.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (cursor.ch >= start && cursor.ch <= end + 80) {
        chosen = { key: m[1], end };
        if (cursor.ch <= end) break;
      }
    }
    if (!chosen) {
      new Notice('No @citekey near cursor.');
      return;
    }
    const page = extractLocator(line, chosen.end);
    this.openCitation(chosen.key, page);
  }

  // ---- Citation pop-ups ----

  // The pop-up's modifier is always Ctrl (Cmd on macOS), whatever the click modifier: a plain hover never opens one.
  isHoverModifier(evt) {
    return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
  }

  isHoverModifierKey(evt) {
    return evt.key === (Platform.isMacOS ? 'Meta' : 'Control');
  }

  onBibMouseMove = (evt) => {
    this.bibPointer = { x: evt.clientX, y: evt.clientY };
    if (!this.settings.hoverPopup) return;
    // over the pop-up: it stays, so that its text can be selected and copied
    if (this.bibPopup && evt.target instanceof Node && this.bibPopup.contains(evt.target)) {
      this.keepBibPopup();
      return;
    }
    const hit = this.isHoverModifier(evt) ? this.hitFromTarget(evt.target) : null;
    if (hit) this.showBibPopup(hit.key, evt.clientX, evt.clientY);
    else this.hideBibPopupSoon();
  };

  onBibKeyDown = (evt) => {
    if (!this.settings.hoverPopup) return;
    // Ctrl/Cmd+Shift+C: the entry shown, copied as found
    if (this.isHoverModifier(evt) && evt.shiftKey && evt.key.toLowerCase() === 'c' && this.bibPopup && this.bibShown) {
      evt.preventDefault();
      evt.stopPropagation();
      const key = this.bibPopupKey;
      navigator.clipboard.writeText(this.bibShown).then(
        () => new Notice(`Copied the entry of @${key}.`),
        () => new Notice('The entry could not be copied to the clipboard.')
      );
      return;
    }
    if (evt.key === 'Escape' && this.bibPopup) {
      this.hideBibPopup();
      return;
    }
    // the modifier pressed with the pointer already resting on a citation
    if (this.isHoverModifierKey(evt) && !evt.repeat && this.bibPointer) {
      const { x, y } = this.bibPointer;
      const hit = this.hitFromTarget(document.elementFromPoint(x, y));
      if (hit) this.showBibPopup(hit.key, x, y);
    }
  };

  onBibKeyUp = (evt) => {
    if (!this.isHoverModifierKey(evt)) return;
    if (this.bibPopup && this.bibPopup.matches(':hover')) return;
    this.hideBibPopupSoon();
  };

  // A hide waiting out the grace period is cancelled.
  keepBibPopup() {
    if (this.bibLeaving !== null) {
      window.clearTimeout(this.bibLeaving);
      this.bibLeaving = null;
    }
  }

  // The pop-up hidden after the grace period, unless the pointer reaches it (or a citation) first.
  hideBibPopupSoon() {
    if (!this.bibPopup && this.bibPending === null) return;
    if (this.bibLeaving !== null) return;
    this.bibLeaving = window.setTimeout(() => {
      this.bibLeaving = null;
      this.hideBibPopup();
    }, POPUP_GRACE_MS);
  }

  hideBibPopup() {
    this.keepBibPopup();
    this.bibPending = null;
    this.bibShown = '';
    this.bibPopupKey = null;
    if (this.bibPopup) {
      this.bibPopup.remove();
      this.bibPopup = null;
    }
  }

  async showBibPopup(key, x, y) {
    this.keepBibPopup();
    // shown already, or being looked up
    if ((this.bibPopup && this.bibPopupKey === key) || this.bibPending === key) return;
    this.bibPending = key;
    let found;
    try {
      found = await this.bibEntry(key);
    } catch (e) {
      console.error('zotero-cite-links: citation pop-up', e);
      found = { error: 'failed' };
    }
    // the pointer left, or moved to another citation, during the lookup: nothing is drawn
    if (this.bibPending !== key) return;
    this.hideBibPopup();

    const pop = document.body.createDiv({ cls: 'zcl-bib-popover popover' });
    this.renderBibPopup(pop, key, found);
    // kept inside the window: a wide entry moves left, a tall one above the pointer
    const pad = 8;
    let left = x + 14;
    let top = y + 14;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, y - h - pad);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.addEventListener('mouseleave', () => this.hideBibPopupSoon());

    this.bibPopup = pop;
    this.bibPopupKey = key;
    this.bibShown = found.text || '';
  }

  renderBibPopup(pop, key, found) {
    if (!found.text) {
      const why = {
        down: 'Zotero is not running on this computer (or Better BibTeX did not answer).',
        missing: 'Zotero does not know this key either.',
        failed: 'The lookup failed (see the developer console).',
      }[found.error] || '';
      pop.createDiv({ cls: 'zcl-bib-message', text: `@${key}: no .bib file in the vault holds it. ${why}` });
      return;
    }
    const parsed = bibFields(found.text);
    if (!parsed) {
      pop.createEl('pre', { cls: 'zcl-bib-raw', text: found.text });
    } else {
      const table = pop.createEl('table');
      const head = table.createEl('tr').createEl('th', { cls: 'zcl-bib-head', text: `${parsed.type} · ${parsed.key}` });
      head.colSpan = 2;
      for (const [name, value] of parsed.fields) {
        const row = table.createEl('tr');
        row.createEl('td', { cls: 'zcl-bib-field', text: name });
        row.createEl('td', { cls: 'zcl-bib-value', text: value });
      }
    }
    const mod = Platform.isMacOS ? 'Cmd' : 'Ctrl';
    pop.createDiv({ cls: 'zcl-bib-source', text: `From ${found.from}. ${mod}+Shift+C copies the entry.` });
  }

  // The entry of `key`: { text, from } from the vault's .bib files, else from Zotero; or { error: 'down' | 'missing' }.
  async bibEntry(key) {
    await this.readVaultBibs();
    const local = this.bibVault.get(key);
    if (local) return local;
    const cached = this.bibFetched.get(key);
    if (cached) return cached;
    const found = await this.exportFromZotero(key);
    if (found.text) this.bibFetched.set(key, found);
    return found;
  }

  // Every .bib file in the vault, read again when one is added, removed or changed; the newest file's entry wins.
  readVaultBibs() {
    const files = this.app.vault.getFiles().filter((f) => f.extension === 'bib');
    files.sort((a, b) => b.stat.mtime - a.stat.mtime);
    const signature = files.map((f) => `${f.path}\u0000${f.stat.mtime}`).join('\u0001');
    if (signature === this.bibVaultSignature) return this.bibVaultReading || Promise.resolve();
    this.bibVaultSignature = signature;
    this.bibVaultReading = (async () => {
      const all = new Map();
      // oldest first, so that a newer file's entry replaces an older one's
      for (const f of files.slice().reverse()) {
        try {
          for (const [k, text] of bibEntries(await this.app.vault.cachedRead(f))) all.set(k, { text, from: f.path });
        } catch (e) {
          console.error(`zotero-cite-links: could not read ${f.path}`, e);
        }
      }
      if (this.bibVaultSignature === signature) this.bibVault = all;
    })();
    return this.bibVaultReading;
  }

  // The key's entry exported by Better BibTeX (Better BibLaTeX), from My Library, then from each group library.
  async exportFromZotero(key) {
    const port = this.settings.zoteroPort;
    const libraries = [null, ...this.libraryNames.filter((n) => n !== 'My Library')];
    for (const lib of libraries) {
      const params = lib === null ? [[key], EXPORT_TRANSLATOR] : [[key], EXPORT_TRANSLATOR, lib];
      const r = await bbtCall(port, 'item.export', params, EXPORT_TIMEOUT_MS);
      if (r.down) return { error: 'down' };
      const text = r.result !== undefined ? exportText(r.result) : '';
      const entry = text ? bibEntries(text).get(key) : null;
      if (entry) return { text: entry, from: 'Zotero (Better BibTeX)' };
    }
    return { error: 'missing' };
  }
};

class ZCLSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // a fork, said where its settings are (user, 2026-10-28)
    const fork = containerEl.createEl('p', { cls: 'setting-item-description' });
    fork.appendText('Zotero Cite Links Enhanced is a fork of the official ');
    fork.createEl('a', { text: 'Zotero Cite Links', href: 'https://github.com/jpeacock29/zotero-cite-links' });
    fork.appendText(' by jpeacock29 (MIT License), which opens a citation at the page printed in the source. The fork\'s repository: ');
    fork.createEl('a', { text: 'github.com/Gameboard-dev/zotero-cite-links-enhanced', href: 'https://github.com/Gameboard-dev/zotero-cite-links-enhanced' });
    fork.appendText('.');

    new Setting(containerEl)
      .setName('Zotero port')
      .setDesc('Better BibTeX JSON-RPC port. Default 23119.')
      .addText((t) =>
        t
          .setPlaceholder('23119')
          .setValue(String(this.plugin.settings.zoteroPort))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.zoteroPort = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Click modifier')
      .setDesc('Which click opens the citation in Zotero.')
      .addDropdown((d) =>
        d
          .addOption('mod', 'Cmd / Ctrl + click')
          .addOption('none', 'Plain click')
          .setValue(this.plugin.settings.modifier)
          .onChange(async (v) => {
            this.plugin.settings.modifier = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Citation pop-ups')
      .setDesc('Hold Ctrl (Cmd on macOS) and point at a citation to see its bibliography entry, from a .bib file in the vault or else from Zotero on this computer. Ctrl/Cmd+Shift+C copies the entry shown.')
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.hoverPopup)
          .onChange(async (v) => {
            this.plugin.settings.hoverPopup = v;
            if (!v) this.plugin.hideBibPopup();
            await this.plugin.saveSettings();
          })
      );
  }
}

/* nosourcemap */