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

const DEFAULT_SETTINGS = {
  zoteroPort: 23119,
  modifier: 'mod',
};

// Node `http` is used (not Obsidian's `requestUrl`) because Better BibTeX's
// JSON-RPC endpoint closes the connection with ERR_EMPTY_RESPONSE when called
// via Electron's `net` module — a known incompatibility with `requestUrl`.
// This plugin is desktop-only, so Node modules are available.
function bbtRpc(port, method, params) {
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
        timeout: RPC_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data).result); }
          catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

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

  async openCitation(citekey, page) {
    if (!citekey) return;
    const { openUrl, annotations } = await this.resolveOpenUrl(citekey);
    let finalUrl = openUrl;
    if (openUrl.includes('open-pdf')) {
      const pageParam = computePageParam(annotations, page);
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
};

class ZCLSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

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
  }
}

/* nosourcemap */