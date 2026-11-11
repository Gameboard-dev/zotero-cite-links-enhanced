'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, MarkdownView, Platform, TFile } = require('obsidian');
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
// how long an entry fetched from Zotero is reused before it is asked for again (so edits in Zotero show)
const FETCHED_FOR_MS = 5 * 60 * 1000;
const EXPORT_TRANSLATOR = 'Better BibLaTeX';
// How long a citation pop-up stays after the pointer leaves its citation (or the modifier is released), so that the
// pointer can cross to it; inside the pop-up it stays until the pointer leaves.
const POPUP_GRACE_MS = 600;

// The hover source registered with Obsidian's Page preview for Ctrl/Cmd + hover over a citation (preview choice "Library note").
const NOTE_PREVIEW_SOURCE = 'zotero-cite-links-enhanced';
// Better BibTeX looks up a whole list of keys in one call; a long list can take Zotero a while.
const LOOKUP_TIMEOUT_MS = 30000;

const DEFAULT_SETTINGS = {
  zoteroPort: 23119,
  hoverPopup: true,
  // what Ctrl/Cmd + hover shows: 'bib' (the bibliography entry) or 'note' (the source's note, at the page cited)
  previewChoice: 'bib',
  sourceNotes: true,
  danglingSkip: '',
  danglingReport: 'Dangling citation keys.md',
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

// ---- Source notes (a click without Ctrl/Cmd; Ctrl/Cmd + hover when the preview choice is the note) ----

// A page marker on a line of its own, read for its label: `<!-- page 204 (214 / 595) -->` (printed label, then PDF page /
// pages) gives `204`; `<!-- page 3 / 9 -->` (no printed labels) gives `3`.
const NOTE_PAGE_RX = /^\s*<!--\s*page\s+([^\s(\/]+)\s*(?:\(\s*\d+\s*\/\s*\d+\s*\)|\/\s*\d+)\s*-->/;

// The 0-based line of the marker of `page` in a note's text, or -1.
function markerLine(text, page) {
  const wanted = String(page);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('<!--') < 0) continue;
    const m = NOTE_PAGE_RX.exec(lines[i]);
    if (m && m[1] === wanted) return i;
  }
  return -1;
}

// ---- Dangling keys ----

// Where a citation may start, as Pandoc reads one: at the start of a line, or after white space, `[`, `;`, `-` (author
// suppressed) or `(`. This keeps out addresses such as `medium.com/@name`, which the editor's underline (CITE_RX alone)
// does not need to.
const CITE_BEFORE = /[\s\[;\-(]/;

// The text of a note with what cannot hold a citation blanked to spaces, so that columns and line numbers are kept:
// the properties block, fenced code and `$$` math blocks, inline code and inline `$…$` math.
function citableText(text) {
  const lines = text.split('\n');
  let fence = null;
  let math = false;
  let i = 0;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === '---' || lines[j].trim() === '...') { i = j + 1; break; }
    }
    for (let j = 0; j < i; j++) lines[j] = '';
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trimStart();
    if (fence) {
      if (t.startsWith(fence)) fence = null;
      lines[i] = '';
      continue;
    }
    const f = /^(`{3,}|~{3,})/.exec(t);
    if (f) { fence = f[1]; lines[i] = ''; continue; }
    const dollars = (line.match(/\$\$/g) || []).length;
    if (math) {
      if (dollars % 2 === 1) math = false;
      lines[i] = '';
      continue;
    }
    if (dollars % 2 === 1) { math = true; lines[i] = ''; continue; }
    lines[i] = line
      .replace(/(`+)[\s\S]*?\1/g, (s) => ' '.repeat(s.length))
      .replace(/\$\$[^$]*\$\$/g, (s) => ' '.repeat(s.length))
      .replace(/(?<![\\$])\$(?=\S)[^$\n]*?(?<=\S)(?<!\\)\$(?!\d)/g, (s) => ' '.repeat(s.length));
  }
  return lines;
}

// Every citation in a note: { key, line } with 1-based lines.
function citationsIn(text) {
  const out = [];
  const lines = citableText(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf('@') < 0) continue;
    CITE_RX.lastIndex = 0;
    let m;
    while ((m = CITE_RX.exec(line)) !== null) {
      if (m.index > 0 && !CITE_BEFORE.test(line[m.index - 1])) continue;
      out.push({ key: m[1], line: i + 1 });
    }
  }
  return out;
}

// The folders to skip, one per line (or separated by commas), as vault paths without slashes at either end.
function skipFolders(setting) {
  return String(setting || '')
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

function inFolders(path, folders) {
  return folders.some((f) => path === f || path.startsWith(`${f}/`));
}

// The report note's text. `missing` maps each key with no item to [{ path, lines }]; `ambiguous` maps a key Zotero matched
// to several items to the number of items.
function danglingReport({ missing, ambiguous, checkedWith, keys, notes, when }) {
  const out = ['# Dangling citation keys', ''];
  out.push(`Checked ${when} against ${checkedWith}: ${keys} distinct keys cited in ${notes} notes, ${missing.size} with no item.`);
  out.push('Each key is followed by the notes that cite it and the lines where it is cited. This note is written again each time the command runs.');
  out.push('');
  const keys1 = [...missing.keys()].sort((a, b) => a.localeCompare(b));
  if (!keys1.length) out.push('Every cited key has an item.');
  for (const key of keys1) {
    out.push(`## @${key}`, '');
    for (const { path, lines } of missing.get(key)) {
      const name = path.replace(/^.*\//, '').replace(/\.md$/, '');
      const link = path.replace(/\.md$/, '');
      out.push(`- [[${link}|${name}]], line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`);
    }
    out.push('');
  }
  if (ambiguous.size) {
    out.push('## Keys matched by more than one item', '');
    for (const [key, n] of [...ambiguous].sort((a, b) => a[0].localeCompare(b[0]))) out.push(`- @${key}: ${n} items`);
    out.push('');
  }
  return out.join('\n');
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

    // Source notes: a click without Ctrl/Cmd opens the cited source's note at the page (from the vault alone, so
    // Zotero need not be running); Ctrl/Cmd + hover previews it when the preview choice is the note.
    this.noteIndex = null;
    this.previewEl = null;
    this.lastPointerEvent = null;
    this.hoverParent = { hoverPopover: null };
    this.registerHoverLinkSource(NOTE_PREVIEW_SOURCE, {
      // the plugin itself waits for Ctrl/Cmd (the pointer's last event may predate the key press)
      display: 'Zotero Cite Links Enhanced (Ctrl/Cmd + hover over a citation)',
      defaultMod: false,
    });
    const dropIndex = () => { this.noteIndex = null; };
    this.registerEvent(this.app.metadataCache.on('changed', dropIndex));
    this.registerEvent(this.app.metadataCache.on('resolved', dropIndex));
    this.registerEvent(this.app.vault.on('rename', dropIndex));
    this.registerEvent(this.app.vault.on('delete', dropIndex));

    this.addCommand({
      id: 'open-note-at-cursor',
      name: 'Open the note of the citation at the cursor',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) {
          const hit = this.citationAtCursor(view);
          if (hit) this.openSourceNote(hit.key, hit.page);
        }
        return true;
      },
    });

    this.addCommand({
      id: 'list-dangling-keys',
      name: 'List dangling citation keys (cited, but with no item in Zotero)',
      callback: () => this.listDanglingKeys(),
    });

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
    document.body.classList.remove('zcl-mod-held', 'zcl-note-click');
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

  // Ctrl/Cmd + click opens the citation in Zotero.
  isOpenModifier(evt) {
    return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
  }

  syncModClass = (evt) => {
    const held = !!(evt && this.isOpenModifier(evt));
    document.body.classList.toggle('zcl-mod-held', held);
    document.body.classList.toggle('zcl-note-click', this.settings.sourceNotes && !held);
  };

  clearModClass = () => {
    document.body.classList.remove('zcl-mod-held');
    document.body.classList.toggle('zcl-note-click', this.settings.sourceNotes);
  };

  // The citation under the pointer: an underlined key, or (in Reading view) a citation written as a link,
  // [[@key, p. 4]], which Obsidian draws as an internal link.
  hitFromTarget(target) {
    const el = this.citeElFromTarget(target);
    if (!el) return null;
    if (el.classList.contains('zcl-cite')) {
      const key = el.getAttribute('data-citekey');
      const page = el.getAttribute('data-page') || null;
      return key ? { key, page } : null;
    }
    const href = el.getAttribute('data-href') || '';
    CITE_RX.lastIndex = 0;
    const m = CITE_RX.exec(href);
    if (!m || m.index !== 0) return null;
    return { key: m[1], page: extractLocator(href, m[0].length) };
  }

  citeElFromTarget(target) {
    if (!(target instanceof Element)) return null;
    return target.closest('.zcl-cite[data-citekey], a.internal-link[data-href^="@"]');
  }

  // A click without Ctrl/Cmd opens the note; Ctrl/Cmd + click opens Zotero.
  onMouseDown = (evt) => {
    if (evt.button !== 0) return;
    if (!this.isNoteModifier(evt) && !this.isOpenModifier(evt)) return;
    if (!this.hitFromTarget(evt.target)) return;
    evt.preventDefault();
    evt.stopPropagation();
  };

  onClick = (evt) => {
    if (evt.button !== 0) return;
    const note = this.isNoteModifier(evt);
    if (!note && !this.isOpenModifier(evt)) return;
    const hit = this.hitFromTarget(evt.target);
    if (!hit) return;
    evt.preventDefault();
    evt.stopPropagation();
    if (note) this.openSourceNote(hit.key, hit.page);
    else this.openCitation(hit.key, hit.page);
  };

  openAtCursor(view) {
    const hit = this.citationAtCursor(view);
    if (hit) this.openCitation(hit.key, hit.page);
  }

  // The citation at (or just before) the cursor, with its page, or null (and a notice).
  citationAtCursor(view) {
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
      return null;
    }
    return { key: chosen.key, page: extractLocator(line, chosen.end) };
  }

  // ---- Source notes ----

  // A click without Ctrl/Cmd (which belong to opening in Zotero) or Alt (the editor's extra cursor).
  isNoteModifier(evt) {
    return this.settings.sourceNotes && !evt.ctrlKey && !evt.metaKey && !evt.altKey;
  }

  // The notes whose `citekey` property is `key`, by path. The index is built when first needed and dropped whenever a
  // note's properties change or a note is renamed or deleted.
  notesFor(key) {
    if (!this.noteIndex) {
      const index = new Map();
      for (const file of this.app.vault.getMarkdownFiles()) {
        const ck = this.app.metadataCache.getFileCache(file)?.frontmatter?.citekey;
        if (typeof ck !== 'string' || !ck) continue;
        if (!index.has(ck)) index.set(ck, []);
        index.get(ck).push(file);
      }
      for (const list of index.values()) list.sort((a, b) => a.path.localeCompare(b.path));
      this.noteIndex = index;
    }
    return this.noteIndex.get(key) || [];
  }

  // A source's main note: the only one, or else the one that links to most of the others (a long source's contents
  // note), or else the first by path.
  mainNote(files) {
    if (files.length === 1) return files[0];
    const paths = new Set(files.map((f) => f.path));
    let best = null;
    let most = 0;
    for (const f of files) {
      const links = this.app.metadataCache.resolvedLinks[f.path] || {};
      const n = Object.keys(links).filter((p) => p !== f.path && paths.has(p)).length;
      if (n > most) { best = f; most = n; }
    }
    return best || files[0];
  }

  // Where a citation leads in the vault: { file, line } (line 0-based, or null for the top), with `pageMissing` when a
  // page was asked for and no note marks it; or null when no note has the key.
  async noteTarget(key, page) {
    const files = this.notesFor(key);
    if (!files.length) return null;
    if (page) {
      for (const file of files) {
        let text;
        try { text = await this.app.vault.cachedRead(file); } catch { continue; }
        const line = markerLine(text, page);
        if (line >= 0) return { file, line };
      }
    }
    return { file: this.mainNote(files), line: null, pageMissing: !!page };
  }

  // Opens the cited source's note at the page: in the tab that shows it already, or else in a new tab, so the note
  // being read stays open.
  async openSourceNote(key, page) {
    const t = await this.noteTarget(key, page);
    if (!t) {
      new Notice(`@${key}: no note in the vault has the citekey property "${key}".`);
      return;
    }
    if (t.pageMissing) new Notice(`@${key}: no note marks page ${page}; the source's main note is open instead.`);
    const shown = this.app.workspace.getLeavesOfType('markdown').find((l) => l.view?.file?.path === t.file.path);
    const leaf = shown || this.app.workspace.getLeaf('tab');
    if (shown) this.app.workspace.setActiveLeaf(shown, { focus: true });
    else await leaf.openFile(t.file, { active: true });
    if (t.line === null) return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const pos = { line: t.line, ch: 0 };
    if (view.getMode() === 'source') {
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
    } else {
      view.previewMode?.applyScroll?.(t.line);
    }
  }

  // Ctrl/Cmd + hover (preview choice "Library note"): the note shown by Obsidian's Page preview, scrolled to the page.
  async previewSourceNote(el, evt) {
    if (this.previewEl === el) return;
    this.previewEl = el;
    const hit = this.hitFromTarget(el);
    if (!hit) return;
    const t = await this.noteTarget(hit.key, hit.page);
    // the pointer left, or moved to another citation, during the lookup
    if (this.previewEl !== el || !t) return;
    this.app.workspace.trigger('hover-link', {
      event: evt,
      source: NOTE_PREVIEW_SOURCE,
      hoverParent: this.hoverParent,
      targetEl: el,
      linktext: t.file.path,
      sourcePath: '',
      state: t.line === null ? undefined : { scroll: t.line },
    });
  }

  // ---- Dangling keys ----

  // Which of `keys` Zotero has no item for, across My Library and the group libraries:
  // { missing: Set, ambiguous: Map(key → items), checkedWith } or { error }.
  async keysWithoutItems(keys) {
    const port = this.settings.zoteroPort;
    let left = keys;
    const ambiguous = new Map();
    const libraries = this.libraryNames.length ? this.libraryNames : ['My Library'];
    for (const lib of libraries) {
      if (!left.length) break;
      const r = await bbtCall(port, 'item.pandoc_filter', [left, true, lib], LOOKUP_TIMEOUT_MS);
      if (r.down) return this.keysWithoutBibEntries(keys);
      if (r.error || !r.result || typeof r.result !== 'object') {
        return { error: `Better BibTeX answered with an error: ${r.error ? JSON.stringify(r.error) : 'no result'}` };
      }
      const errors = r.result.errors || {};
      const next = [];
      for (const key of left) {
        if (!(key in errors)) continue;
        const n = Number(errors[key]);
        if (n > 1) ambiguous.set(key, n);
        else next.push(key);
      }
      left = next;
    }
    return { missing: new Set(left), ambiguous, checkedWith: 'Zotero (Better BibTeX)' };
  }

  // When Zotero does not answer: the keys that no .bib file in the vault holds.
  async keysWithoutBibEntries(keys) {
    const bibs = this.app.vault.getFiles().filter((f) => f.extension === 'bib');
    if (!bibs.length) {
      return { error: 'Zotero is not running (or Better BibTeX did not answer), and the vault holds no .bib file to check against.' };
    }
    await this.readVaultBibs();
    return {
      missing: new Set(keys.filter((k) => !this.bibVault.has(k))),
      ambiguous: new Map(),
      checkedWith: `the vault's .bib files (${bibs.map((f) => f.path).join(', ')}), because Zotero did not answer`,
    };
  }

  async listDanglingKeys() {
    const skip = skipFolders(this.settings.danglingSkip);
    const reportPath = String(this.settings.danglingReport || DEFAULT_SETTINGS.danglingReport).trim().replace(/^\/+/, '');
    const notice = new Notice('Listing dangling citation keys…', 0);
    try {
      const where = new Map();
      let notes = 0;
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (file.path === reportPath || inFolders(file.path, skip)) continue;
        let text;
        try { text = await this.app.vault.cachedRead(file); } catch { continue; }
        if (text.indexOf('@') < 0) continue;
        const cites = citationsIn(text);
        if (!cites.length) continue;
        notes++;
        for (const { key, line } of cites) {
          if (!where.has(key)) where.set(key, new Map());
          const byNote = where.get(key);
          if (!byNote.has(file.path)) byNote.set(file.path, []);
          const lines = byNote.get(file.path);
          if (lines[lines.length - 1] !== line) lines.push(line);
        }
      }
      const keys = [...where.keys()];
      if (!keys.length) {
        new Notice('No citations found in the notes checked.');
        return;
      }
      const found = await this.keysWithoutItems(keys);
      if (found.error) {
        new Notice(`Dangling citation keys: ${found.error}`, 10000);
        return;
      }
      const missing = new Map();
      for (const key of found.missing) {
        const byNote = [...where.get(key)].sort((a, b) => a[0].localeCompare(b[0]));
        missing.set(key, byNote.map(([path, lines]) => ({ path, lines })));
      }
      const text = danglingReport({
        missing,
        ambiguous: found.ambiguous,
        checkedWith: found.checkedWith,
        keys: keys.length,
        notes,
        when: window.moment ? window.moment().format('YYYY-MM-DD HH:mm') : new Date().toISOString(),
      });
      if (!reportPath.endsWith('.md')) {
        new Notice(`Dangling citation keys: the report note "${reportPath}" must end in .md (Settings → Zotero Cite Links Enhanced).`, 10000);
        return;
      }
      const existing = this.app.vault.getAbstractFileByPath(reportPath);
      if (existing && !(existing instanceof TFile)) {
        new Notice(`Dangling citation keys: "${reportPath}" is a folder; choose another report note in the settings.`, 10000);
        return;
      }
      let file;
      if (existing) {
        file = existing;
        await this.app.vault.modify(existing, text);
      } else {
        file = await this.app.vault.create(reportPath, text);
      }
      await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
      new Notice(`${found.missing.size} dangling citation key${found.missing.size === 1 ? '' : 's'} of ${keys.length}: see ${reportPath}.`);
    } catch (e) {
      console.error('zotero-cite-links: listing dangling keys', e);
      new Notice(`Dangling citation keys: the listing failed (${e && e.message ? e.message : e}). See the developer console.`, 10000);
    } finally {
      notice.hide();
    }
  }

  // ---- Citation pop-ups ----

  // The pop-up's modifier is always Ctrl (Cmd on macOS), whatever the click modifier: a plain hover never opens one.
  isHoverModifier(evt) {
    return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
  }

  isHoverModifierKey(evt) {
    return evt.key === (Platform.isMacOS ? 'Meta' : 'Control');
  }

  // Ctrl/Cmd + hover shows the source's note instead of the entry.
  previewsNote() {
    return this.settings.hoverPopup && this.settings.previewChoice === 'note';
  }

  onBibMouseMove = (evt) => {
    this.bibPointer = { x: evt.clientX, y: evt.clientY };
    this.lastPointerEvent = evt;
    if (this.previewsNote()) {
      const noteEl = this.isHoverModifier(evt) ? this.citeElFromTarget(evt.target) : null;
      if (noteEl) this.previewSourceNote(noteEl, evt);
      else this.previewEl = null;
      return;
    }
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
    // Ctrl/Cmd pressed with the pointer already resting on a citation: its note previewed
    if (this.previewsNote()) {
      if (this.isHoverModifierKey(evt) && !evt.repeat && this.bibPointer) {
        const { x, y } = this.bibPointer;
        const el = this.citeElFromTarget(document.elementFromPoint(x, y));
        if (el) {
          this.previewEl = null;
          this.previewSourceNote(el, this.lastPointerEvent || evt);
        }
      }
      return;
    }
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
      pop.createDiv({ cls: 'zcl-bib-message', text: `@${key}: no entry found. ${why}` });
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
  }

  // The entry of `key`: { text, from } from Zotero (Better BibTeX), which needs no .bib file; only when Zotero does not
  // answer, from a .bib file in the vault, if one holds the key (any .bib, wherever it is); or { error: 'down' | 'missing' }.
  async bibEntry(key) {
    const cached = this.bibFetched.get(key);
    if (cached && Date.now() - cached.at < FETCHED_FOR_MS) return cached;
    const found = await this.exportFromZotero(key);
    if (found.text) {
      this.bibFetched.set(key, { ...found, at: Date.now() });
      return found;
    }
    if (found.error !== 'down') return found;
    await this.readVaultBibs();
    return this.bibVault.get(key) || found;
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
      .setName('Citation pop-ups')
      .setDesc('Hold Ctrl (Cmd on macOS) and point at a citation to see a preview of it; what the preview shows is set by "Preview choice" below.')
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.hoverPopup)
          .onChange(async (v) => {
            this.plugin.settings.hoverPopup = v;
            if (!v) this.plugin.hideBibPopup();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Preview choice')
      .setDesc('What Ctrl/Cmd + hover over a citation shows. "Zotero Bib": its bibliography entry, from Zotero on this computer (Better BibTeX) or else from a .bib file in the vault; Ctrl/Cmd+Shift+C copies the entry shown. "Library note": the source\'s own note in the vault, scrolled to the page cited, in Obsidian\'s page preview (the core plugin Page preview must be on); this needs no Zotero.')
      .addDropdown((d) =>
        d
          .addOption('bib', 'Zotero Bib')
          .addOption('note', 'Library note')
          .setValue(this.plugin.settings.previewChoice)
          .onChange(async (v) => {
            this.plugin.settings.previewChoice = v;
            this.plugin.hideBibPopup();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Source notes')
      .setDesc('A click on a citation (without Ctrl/Cmd) opens the note in the vault whose citekey property is the citation\'s key (a long source\'s contents note), at the page cited, when the note marks its pages with <!-- page N … --> comments; a notice says when no note has the key. It reads only the vault, so Zotero need not be running. Ctrl/Cmd + click still opens the citation in Zotero. Turn this off if a click on a citation should place the cursor as usual.')
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.sourceNotes)
          .onChange(async (v) => {
            this.plugin.settings.sourceNotes = v;
            this.plugin.clearModClass();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Dangling keys: folders to skip')
      .setDesc('The command "List dangling citation keys" reads every note for @keys and asks Zotero which have no item. Folders listed here (one per line, as vault paths) are not read: for example the folder of the sources\' own notes, whose text holds @ signs that are not citations. Empty reads every note.')
      .addTextArea((t) =>
        t
          .setPlaceholder('Sources\nTemplates')
          .setValue(this.plugin.settings.danglingSkip)
          .onChange(async (v) => {
            this.plugin.settings.danglingSkip = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Dangling keys: report note')
      .setDesc('The note the command writes its list to (replaced each time it runs), as a vault path ending in .md. Default: "Dangling citation keys.md" at the top of the vault.')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.danglingReport)
          .setValue(this.plugin.settings.danglingReport)
          .onChange(async (v) => {
            this.plugin.settings.danglingReport = v.trim() || DEFAULT_SETTINGS.danglingReport;
            await this.plugin.saveSettings();
          })
      );
  }
}

// The pure functions, for the tests in tests/run.js (not used by Obsidian).
module.exports.internals = { markerLine, citableText, citationsIn, skipFolders, inFolders, danglingReport };

/* nosourcemap */