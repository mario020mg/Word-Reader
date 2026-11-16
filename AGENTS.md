# AGENTS.md

## Layout

- `index.html`: markup for the reader area, progress bar, controls and the right panel (textarea, text view `#doc`, PDF view `#pdf`, PDF/Text switch). Loads pdf.js from a CDN and `app.js` (both `defer`).
- `style.css`: dark theme, CSS variables in `:root`. Two-column grid (reader left, sticky full-height text panel right) that stacks below 900px, plus a small-screen media query at 480px.
- `app.js`: all the logic in one plain classic script, with no modules and no dependencies.
  - Text parsing: `parseText` returns tokens with source offsets and a `kept` flag. `cleanWord` strips runs of 4+ identical characters, and runs of 4+ identical words (case-insensitive) are dropped. `setText` builds `state.words` from the kept tokens plus the document view.
  - Document view (`#doc`, right panel): original text with `white-space: pre-wrap`. Kept words are `span.w[data-i]` (click to seek) and dropped ones are `span.junk`. `highlightDoc` marks the current word and scrolls only the panel. The mark is a separate `.doc-mark` box, a sibling of the text block, moved with `transform`. Never style the current word's span itself (a background on an inline span relayouts the whole text, ~50 ms per word on long texts). `#doc` and `.reader` use `contain: strict` for the same reason. The right panel shows one of the textarea, `#doc` or `#pdf`, chosen by `showPanel('edit' | 'text' | 'pdf')`. `state.view` remembers PDF vs Text.
  - PDF view (`#pdf`): one `.pdf-page` placeholder per page (CSS `aspect-ratio`). An `IntersectionObserver` (±1 screen) decides which pages to draw. `pumpRender` draws at most 2 at a time, nearest first, and pages are freed when they leave the zone. The current word is marked by `.pdf-mark` boxes placed in % of the page (`placeBox`), so they're correct at any width. `pdfWordAt` maps clicks and hover to the nearest word box on the page.
  - Word boxes: `state.layout` has one `{ p, r: [[x0,y0,x1,y1]…] }` entry (page fractions) per `\S+` token of `loadedText`. `state.boxes` holds the same objects, one per kept word, and `state.pageIdx` / `state.pageRange` index them by page. Text-layer PDFs: `textLayerWords` splits pdf.js items into words. Glyph widths start as a generic-font estimate; `refinePage` recomputes them with the PDF's own fonts (`loadedFonts`) once a page is drawn, giving the leftover width to spaces so justified lines are exact. OCR: `ocrWords` uses Tesseract word bboxes. `layoutPage` reflows lines into paragraphs (`reflowLines`, whitespace only) and joins hyphenated words (two rects). Words never contain whitespace, so the tokens line up 1:1 with the layout. Keep it that way.
  - Pure helpers: `tokenize`, `orpIndex` (focus letter at ~35% of the letters, ignoring leading and trailing punctuation), `delayMultiplier`, `clampWpm`.
  - Rendering: `renderWord` splits a word into before / focus / after spans. `fitFont` shrinks the font with canvas `measureText` when a word would overflow. It uses metrics cached by `refreshBaseFont` (on load and resize), so it doesn't read layout on every word.
  - Playback: a `setTimeout` chain (`schedule` → `tick`). The delay is `60000 / wpm × multiplier` and is read on every tick. Changing WPM reschedules without touching `state.index`.
  - PDF loading: `openPdf` → `readPdf` (pdf.js text layer). If that is empty or `looksGarbled` (over 60% of tokens lack two consecutive letters), `ocrPdf` renders each page to a canvas and runs Tesseract.js (`spa+eng`), calling back per page. `ocrProgressively` starts reading after `OCR_FIRST_PAGES` (3) pages and adds the rest with `appendText` (no change to index or playback). `state.ocr` is `{page, total}` while pages are still coming. When playback catches up it waits (`state.waiting`) instead of finishing. Loading other text, or editing the textarea, calls `stopOcr`. Tesseract is lazy-loaded from jsDelivr by `loadTesseract` only when needed. `fileJob` is bumped per file so a newer file cancels a running OCR.
  - Persistence: `localStorage` key `word-reader-v1` (wpm, punctuation toggle, text, index, view). The PDF is kept in IndexedDB (`word-reader` / `kv`): `pdf` = `{ name, bytes }` and `layout` = `{ text, layout, sizes, textLayer, total, done }`. `schedulePdfSave` throttles writes to one every 1.5 s. `restorePdf` re-attaches the PDF on startup if its text matches, and resumes the OCR from page `done + 1`. `detachPdf` (text edited / other file) deletes both.

## Run

Open `index.html` in a browser. There's no build, server or package install.
The project Run button runs `xdg-open index.html`.

## Conventions

- Keep it build-free: vanilla HTML/CSS/JS, no frameworks, no bundler.
- ORP alignment depends on `.display` being a `1fr auto 1fr` grid. The equal side columns keep the focus letter's centre on the box centre. Don't change it to flex.
- The reader box has a fixed height and must never resize when the word changes.
- Keyboard shortcuts are ignored while the textarea or the number input has focus.
- Test at a 360px viewport width as well as on desktop.
- Moving the PDF marks must stay cheap: they live inside the page div (`contain: layout paint`), and nothing restyles the canvases or the text per word.
