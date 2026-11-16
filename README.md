# Word Reader

A speed reader that shows one word at a time in the same spot. The red focus letter stays fixed so your eyes never move.

## Open it

**Online:** https://mario020mg.github.io/Word-Reader/ (works on phones too).

Or locally: Double-click `index.html` to open it in any browser. There's nothing to install and no build step.
(Reading PDFs loads pdf.js from a CDN, so PDFs need an internet connection. Pasted text works offline.)

## Use it

1. Paste text into the box, or click **Open PDF / TXT**, or drag a file onto the page.
2. Press **Start**.
3. Set the speed with the slider (100–1500 WPM) or type any number (50–5000) into the box. You can also scroll the mouse wheel over the speed controls. Changes apply right away, even while it's playing.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Step back / forward one word |
| Shift + ← / → | Jump to previous / next sentence |
| ↑ / ↓ | Speed ±25 WPM |

- **Pause longer on punctuation** keeps words ending in `, ; :` on screen 1.5× longer and words ending in `. ! ?` 2.2× longer. Untick it to keep a steady pace.
- The full text is shown in the panel on the right, with the current word highlighted. Click any word to jump there. Use **Edit text** to change it.
- **PDFs show the real pages.** When the text comes from a PDF, the panel shows the actual PDF (switch with **PDF / Text**). The current word is marked on the page, and the view scrolls to follow it. Click any word on the page to jump there. This lets you check the original when the extracted or OCR'd text is wrong, and see figures, tables and formulas. The PDF is kept in the browser, so it comes back next time (an unfinished OCR picks up where it stopped). Editing the text detaches the PDF.
- Junk is skipped automatically. Any character repeated more than 3 times in a row is removed (`.........`, `____`, `!!!!`), and so is a word repeated more than 3 times in a row (the whole run). Skipped bits show struck through in the text panel.
- Drag the progress bar to jump anywhere in the text.
- Your text, position, speed and settings are saved in the browser and come back the next time you open the page.

**Scanned or broken PDFs are OCR'd automatically.** If a PDF has no text layer (a scan), or its text comes out as garbage (`! " # $ %` — broken font encoding), the reader runs OCR (Tesseract.js, Spanish + English) in the browser. It loads from a CDN the first time (a few MB, needs internet) and takes a few seconds per page. You can start reading after the first 3 pages. The rest keep being added in the background (the counter shows `OCR 12/40`), and if you catch up, the reader waits for the next page. Opening another file or editing the text stops it.
