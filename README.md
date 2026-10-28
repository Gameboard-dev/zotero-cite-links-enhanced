# Zotero Cite Links Enhanced

A fork of the Obsidian plugin [Zotero Cite Links](https://github.com/jpeacock29/zotero-cite-links) 0.2.0 by jpeacock29 (MIT License). The original underlines each Pandoc `@citekey` in a note and opens it in Zotero on Cmd/Ctrl+click, at the page given after it (`[@oates2006, p. 285]`).

## What the fork adds

- **Its own id**, `zotero-cite-links-enhanced`, so that the original's updates never replace it.
- **Printed pages.** A locator is read as the page printed in the source, not the PDF's page (see below).
- **Citation pop-ups.** Ctrl/Cmd + hover over a citation shows its bibliography entry (see below).

## Printed pages

Zotero's `zotero://open-pdf/...?page=N` takes the PDF's page (page index + 1), so the original opened a printed page number as a PDF page unless that page carried a Zotero annotation: book citations landed several pages early.

The fork turns the printed page into the PDF page with the page markers of the paper's compiled note in the vault, `<!-- page 291 (310 / 360) -->` (printed label, then PDF page / pages). The note is found by its `zotero_pdf` property (the attachment's open-pdf address), or else by its `citekey`. When the note has no printed labels (markers like `<!-- page 44 / 388 -->`) or the page is not found, the plugin behaves as the original (annotation labels, then the number as given).

## Citation pop-ups

- **Trigger.** Hold Ctrl (Cmd on macOS) and point at a citation, in the editor or in Reading view. The pop-up shows the citation's bibliography entry as a table: the entry's type and key, then each field's name and value. Pressing Ctrl/Cmd while the pointer already rests on a citation shows the pop-up too. Ctrl/Cmd+click still opens the citation in Zotero as before.
- **Where the entry comes from.** First from the `.bib` files in the vault (every `.bib` file; when two hold the same key, the most recently changed one wins; a file is read again when it changes). A key that no `.bib` file holds is asked of Zotero on this computer through Better BibTeX (its JSON-RPC method `item.export` with the Better BibLaTeX translator, on `127.0.0.1` at the port set in the settings), so no exported `.bib` file is needed. If Zotero is not running, the pop-up says so.
- **Selecting text.** The pop-up stays open while the pointer is over it, and for a moment after the pointer leaves the citation or the key is released, so the pointer can move into it. Its text can be selected and copied. Escape closes it.
- **Copy shortcut.** Ctrl/Cmd+Shift+C copies the whole entry shown, as found (BibLaTeX when it came from Zotero).
- **Setting.** *Citation pop-ups* (on by default) turns the feature on or off.
- **Requirements.** For keys that are not in a `.bib` file in the vault: Zotero running on the same computer with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) extension installed. Entries from the vault's `.bib` files need neither.

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
