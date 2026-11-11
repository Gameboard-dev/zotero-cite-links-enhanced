# Zotero Cite Links Enhanced

A fork of the Obsidian plugin [Zotero Cite Links](https://github.com/jpeacock29/zotero-cite-links) 0.2.0 by jpeacock29 (MIT License). The original underlines each Pandoc `@citekey` in a note and opens it in Zotero on Cmd/Ctrl+click, at the page given after it (`[@oates2006, p. 285]`).

## What the fork adds

- **Its own id**, `zotero-cite-links-enhanced`, so that the original's updates never replace it.
- **Printed pages.** A locator is read as the page printed in the source, not the PDF's page (see below).
- **Citation pop-ups.** Ctrl/Cmd + hover over a citation shows its bibliography entry, or the source's own note at the page cited (setting *Preview choice*; see below).
- **Source notes.** A click (without Ctrl/Cmd) opens the cited source's own note in the vault at the page cited, with no need for Zotero (see below).
- **Dangling keys.** A command lists every cited key that has no item in Zotero, with the notes and lines that cite it (see below).

## Printed pages

Zotero's `zotero://open-pdf/...?page=N` takes the PDF's page (page index + 1), so the original opened a printed page number as a PDF page unless that page carried a Zotero annotation: book citations landed several pages early.

The fork turns the printed page into the PDF page with the page markers of the paper's compiled note in the vault, `<!-- page 291 (310 / 360) -->` (printed label, then PDF page / pages). The note is found by its `zotero_pdf` property (the attachment's open-pdf address), or else by its `citekey`. When the note has no printed labels (markers like `<!-- page 44 / 388 -->`) or the page is not found, the plugin behaves as the original (annotation labels, then the number as given).

## Citation pop-ups

- **Trigger.** Hold Ctrl (Cmd on macOS) and point at a citation, in the editor or in Reading view. The pop-up shows the citation's bibliography entry as a table: the entry's type and key, then each field's name and value. Pressing Ctrl/Cmd while the pointer already rests on a citation shows the pop-up too. Ctrl/Cmd+click still opens the citation in Zotero as before.
- **Where the entry comes from.** From Zotero on this computer, through Better BibTeX (its JSON-RPC method `item.export` with the Better BibLaTeX translator, on `127.0.0.1` at the port set in the settings), so no exported `.bib` file is needed. An entry is kept for five minutes, then asked for again, so edits in Zotero show. Only when Zotero does not answer (not running, or Better BibTeX missing) is the key looked up in the vault's `.bib` files, if there are any (every `.bib` file, wherever it is; when two hold the same key, the most recently changed one wins). If neither has it, the pop-up says why.
- **Selecting text.** The pop-up stays open while the pointer is over it, and for a moment after the pointer leaves the citation or the key is released, so the pointer can move into it. Its text can be selected and copied. Escape closes it.
- **Copy shortcut.** While the pop-up is open, Ctrl/Cmd+Shift+C copies the whole entry shown, as BibLaTeX source (as written in the `.bib` file when it came from one). The pop-up itself shows only the entry.
- **Settings.** *Citation pop-ups* (on by default) turns the feature on or off. *Preview choice* sets what the pop-up shows: *Zotero Bib* (the default; the entry, as described here) or *Library note* (the source's own note, scrolled to the page cited, in Obsidian's page preview, found as under *Source notes* below and needing no Zotero; the core plugin *Page preview* must be on).
- **Requirements.** Zotero running on the same computer with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) extension installed. Without them, only keys held in a `.bib` file in the vault are shown.

## Source notes

For vaults that hold a note per source (for example notes converted from the sources' PDFs), with the source's citation key in the note's `citekey` property.

- **A click** on a citation without Ctrl/Cmd (or Alt) opens the source's note. Only the vault is read, so Zotero need not be running. When no note has the key, a notice says so. With a page (`[@smith2020, p. 204]`), it opens the note that marks that page and moves to the marker: a line `<!-- page 204 (214 / 595) -->` (the printed page, then the PDF page / pages) or `<!-- page 204 / 595 -->` (when the source prints no page numbers). Without a page, or when no note marks it (a notice says so), it opens the source's main note: its only note, or, when a long source is split into several notes with the same `citekey`, the note that links to most of the others (its contents note). A tab that already shows the note is reused; otherwise the note opens in a new tab, so the note being read stays open.
- **Ctrl/Cmd + hover** shows the same note, at the same page, when *Preview choice* is *Library note* (see *Citation pop-ups*).
- **Command** *Open the note of the citation at the cursor* does the same as a click, from the keyboard.
- **Setting.** *Source notes* (on by default) turns the click off, so that a click on a citation places the cursor as usual. While it is on, the cursor cannot be put inside a citation with the mouse: click beside it and use the arrow keys.
- **Links.** A citation written as a link (`[[@key, p. 4]]`) is handled the same way in the editor and in Reading view, so a click opens the source's note rather than an empty note named `@key, p. 4`.

## Dangling keys

The command *List dangling citation keys (cited, but with no item in Zotero)* reads every note for citations, asks Zotero (Better BibTeX's `item.pandoc_filter`, one call per library) which keys have no item, and writes the answer to a report note, which it opens: each key with no item, the notes that cite it and their line numbers. Keys Zotero matches to more than one item are listed apart. When Zotero does not answer, the keys are checked against the vault's `.bib` files instead, and the report says so.

- **What counts as a citation.** `@key` where a Pandoc citation can start: at the start of a line or after white space, `[`, `;`, `-` or `(`. So `[@key, p. 4]`, `[[@key, p. 4]]`, `-@key` and a narrative `@key` count; `name@example.com` and `medium.com/@name` do not. Keys keep their digits, hyphens, colons and dots (`@iso-12345-6`). The properties block, code (fenced and inline) and math (`$…$`, `$$…$$`) are skipped. Other text that looks like a citation (`@` before a word in a quotation) is reported, since only the reader can tell.
- **Settings.** *Dangling keys: folders to skip* (one vault path per line; for example the folder of the sources' own notes, whose text holds @ signs that are not citations) and *Dangling keys: report note* (default `Dangling citation keys.md`, replaced each time).

## Tests

`node tests/run.js` checks the pure functions (page markers, citation scanning, the report) with Obsidian stubbed.

## Files

- `main.js`, `manifest.json`, `styles.css`: the plugin, installed in `<vault>/.obsidian/plugins/zotero-cite-links-enhanced/`. No build step.
- `versions.json`: the minimum Obsidian version of each release.
- `original-0.2.0/`: the original plugin as released.
- `local-printed-pages.patch`: the printed-pages change as a diff of the original's `main.js`.

## Install by hand

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/zotero-cite-links-enhanced/`, then turn the plugin on under Settings → Community plugins (or off and on again to reload it).

## Credit

The fork's repository: <https://github.com/Gameboard-dev/zotero-cite-links-enhanced>. The original, by jpeacock29:
<https://github.com/jpeacock29/zotero-cite-links>.

## Licence

MIT, as the original: `LICENSE` is the original's, unchanged (Copyright (c) 2026 jpeacock29), and covers the fork's
changes too.
