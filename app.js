'use strict';

// ---------- Settings ----------
const WPM_MIN = 50;
const WPM_MAX = 5000;          // number input allows going past the slider
const WPM_STEP_KEYS = 25;
const STORAGE_KEY = 'word-reader-v1';

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const els = {
  display: $('display'), before: $('before'), focus: $('focus'), after: $('after'),
  status: $('status'), progress: $('progress'), counter: $('counter'),
  play: $('play'), back: $('back'), fwd: $('fwd'), restart: $('restart'),
  wpmRange: $('wpmRange'), wpmNum: $('wpmNum'), wpmLabel: $('wpmLabel'), speedBox: $('speedBox'),
  punct: $('punct'), text: $('text'), file: $('file'), start: $('start'),
  doc: $('doc'), pdf: $('pdf'), edit: $('edit'),
  viewSwitch: $('viewSwitch'), viewPdf: $('viewPdf'), viewText: $('viewText'),
};

// ---------- State ----------
const state = {
  words: [],
  index: 0,
  playing: false,
  timer: null,
  wpm: 300,
  finished: false,
  loadedText: '',   // the text state.words was built from
  ocr: null,        // { page, total } while OCR is still adding pages in the background
  waiting: false,   // playback reached the end of the OCR'd pages and is waiting for more
  // PDF the text came from (null for pasted text / TXT files)
  pdf: null,        // { doc (pdf.js document), sizes: [{ w, h }], name, textLayer, refined }
  layout: null,     // one entry per token (\S+ run) of loadedText: { p: page, r: [[x0, y0, x1, y1], …] }
  boxes: null,      // the same entries, one per word (aligned with state.words)
  pageIdx: null,    // page number -> indices of the words on that page
  pageRange: null,  // page number -> [first, end) of its entries in layout
  panel: 'edit',    // what the right panel shows: 'edit' (textarea) | 'text' | 'pdf'
  view: 'pdf',      // preferred reading view when a PDF is attached
};

// ---------- Pure helpers ----------
function tokenize(text) {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/** Remove any run of the same character repeated more than 3 times ("....", "____"). */
function cleanWord(word) {
  return word.replace(/(.)\1{3,}/gu, '');
}

/**
 * Split text into tokens with their position in the source text, and mark junk:
 * - words that become empty after cleanWord()
 * - the same word repeated more than 3 times in a row (whole run is dropped)
 * Returns [{ start, end, word, kept }] in text order.
 */
function parseText(text) {
  const tokens = [];
  for (const m of text.matchAll(/\S+/g)) {
    const word = cleanWord(m[0]);
    tokens.push({ start: m.index, end: m.index + m[0].length, word, kept: word.length > 0 });
  }
  const live = tokens.filter((t) => t.kept);
  for (let i = 0; i < live.length;) {
    const key = live[i].word.toLowerCase();
    let j = i + 1;
    while (j < live.length && live[j].word.toLowerCase() === key) j++;
    if (j - i > 3) for (let k = i; k < j; k++) live[k].kept = false;
    i = j;
  }
  return tokens;
}

/** Index of the "optimal recognition point" letter, ~35% into the word (letters only). */
function orpIndex(word) {
  // Skip leading/trailing punctuation so "(hello," focuses on a letter.
  const m = word.match(/^[^\p{L}\p{N}]*/u);
  const lead = m ? m[0].length : 0;
  const core = word.slice(lead).replace(/[^\p{L}\p{N}]+$/u, '');
  if (core.length === 0) return Math.floor((word.length - 1) / 2);
  return lead + Math.min(core.length - 1, Math.floor(core.length * 0.35));
}

/** How much longer a word stays on screen, based on trailing punctuation. */
function delayMultiplier(word) {
  const w = word.replace(/["'”’»)\]}]+$/u, '');
  const last = w.slice(-1);
  if ('.!?…'.includes(last)) return 2.2;
  if (',;:'.includes(last)) return 1.5;
  if (last === '-' || last === '—') return 1.3;
  return 1;
}

function clampWpm(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return state.wpm;
  return Math.min(WPM_MAX, Math.max(WPM_MIN, n));
}

// ---------- Rendering ----------
let baseFontSize = 56;
let fontFamily = 'sans-serif';
let availWidth = 0;        // usable width inside .display, cached (refreshed on resize)
let currentFontSize = 0;
const measureCtx = document.createElement('canvas').getContext('2d');

/**
 * Read the display's metrics once (load / resize) instead of on every word:
 * reading layout right after writing to the DOM forces a full-page reflow per tick.
 */
function refreshBaseFont() {
  els.display.style.fontSize = '';
  currentFontSize = 0;
  const cs = getComputedStyle(els.display);
  baseFontSize = parseFloat(cs.fontSize) || 56;
  fontFamily = cs.fontFamily;
  availWidth = els.display.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

function textWidth(text, size, bold) {
  measureCtx.font = `${bold ? 700 : 400} ${size}px ${fontFamily}`;
  return measureCtx.measureText(text).width;
}

/** Shrink the font if a long word would overflow the box (focus stays centred). */
function fitFont(before, focus, after) {
  const wb = textWidth(before, baseFontSize, false);
  const wf = textWidth(focus, baseFontSize, true);
  const wa = textWidth(after, baseFontSize, false);
  const needed = 2 * Math.max(wb, wa) + wf;
  const scale = needed > availWidth ? availWidth / needed : 1;
  const size = Math.max(10, Math.floor(baseFontSize * scale));
  if (size !== currentFontSize) {   // skip the style write when nothing changes
    currentFontSize = size;
    els.display.style.fontSize = `${size}px`;
  }
}

function renderWord(word) {
  if (!word) {
    els.before.textContent = els.focus.textContent = els.after.textContent = '';
    return;
  }
  const i = orpIndex(word);
  const before = word.slice(0, i), focus = word[i], after = word.slice(i + 1);
  fitFont(before, focus, after);
  els.before.textContent = before;
  els.focus.textContent = focus;
  els.after.textContent = after;
}

function renderProgress() {
  const total = state.words.length;
  els.progress.max = Math.max(0, total - 1);
  els.progress.value = state.index;
  const ocr = state.ocr ? ` · OCR ${state.ocr.page}/${state.ocr.total}` : '';
  els.counter.textContent = `${total ? state.index + 1 : 0} / ${total}${ocr}`;
}

function renderCurrent() {
  renderWord(state.words[state.index]);
  renderProgress();
  highlightDoc();
  highlightPdf();
}

// ---------- Document view (full text on the right) ----------
let docSpans = [];
let docActive = null;

/** Build the read-only view: original layout, kept words clickable, junk dimmed. */
function buildDoc(text, tokens) {
  docSpans = [];
  docActive = null;
  docText.replaceChildren(docFragment(text, tokens));
  els.doc.replaceChildren(docText, docMark);
}

/** Spans for `text`; kept words are numbered after the ones already in docSpans. */
function docFragment(text, tokens) {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const t of tokens) {
    if (t.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, t.start)));
    const span = document.createElement('span');
    span.textContent = text.slice(t.start, t.end);
    if (t.kept) {
      span.className = 'w';
      span.dataset.i = docSpans.length;
      docSpans.push(span);
    } else {
      span.className = 'junk';
    }
    frag.appendChild(span);
    pos = t.end;
  }
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  return frag;
}

/**
 * The current word is marked by a separate box moved with `transform`, not by
 * styling the word's span: giving an inline span a background makes the browser
 * re-lay-out the whole text (~50 ms per word with a long text), which made
 * playback crawl. The marker is a sibling of the text block (not inside it) so
 * moving it never invalidates the text's layout.
 */
const docText = document.createElement('div');
const docMark = document.createElement('div');
docMark.className = 'doc-mark';

function highlightDoc() {
  const span = docSpans[state.index];
  if (docActive === span) return;
  docActive = span || null;
  docMark.hidden = !span;
  if (!span || els.doc.hidden) return;
  const top = span.offsetTop;
  docMark.style.transform = `translate(${span.offsetLeft - 2}px, ${top}px)`;
  docMark.style.width = `${span.offsetWidth + 4}px`;
  docMark.style.height = `${span.offsetHeight}px`;
  // Keep the current word in view without scrolling the whole page.
  const view = els.doc.clientHeight;
  if (top < els.doc.scrollTop + 20 || top > els.doc.scrollTop + view - 40) {
    els.doc.scrollTop = top - view / 3;
  }
}

// ---------- PDF view (the real pages on the right) ----------
/*
 * Every page gets a placeholder div with the page's aspect ratio. Pages are only
 * drawn (pdf.js -> canvas) while they are near the visible area and freed when they
 * scroll away, so big PDFs don't eat memory. The current word is marked with boxes
 * positioned in % of the page, so they stay right at any panel width.
 */
// Draw at >= 1.5x even on 1x screens: downscaled text looks noticeably crisper.
const PDF_DPR = Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2);
const PDF_MAX_RENDERS = 2;    // pages drawn in parallel
const pdfView = {
  pages: [],                  // placeholder div per page
  want: new Set(),            // pages near the visible area (should be drawn)
  busy: 0,
  io: null,
  marks: [],                  // current-word boxes (a hyphenated word can have two)
  hover: null,                // box under the mouse
  hoverIdx: -1,
  active: -1,                 // word index the marks are showing
};

function buildPdfView() {
  teardownPdfView();
  pdfView.io = new IntersectionObserver(onPdfIntersect, { root: els.pdf, rootMargin: '100% 0px' });
  const frag = document.createDocumentFragment();
  pdfView.pages = state.pdf.sizes.map((s, i) => {
    const div = document.createElement('div');
    div.className = 'pdf-page';
    div.style.aspectRatio = `${s.w} / ${s.h}`;
    div.dataset.p = i + 1;
    frag.appendChild(div);
    return div;
  });
  els.pdf.replaceChildren(frag);
  for (const div of pdfView.pages) pdfView.io.observe(div);
}

function teardownPdfView() {
  if (pdfView.io) pdfView.io.disconnect();
  for (const div of pdfView.pages) releasePage(div);
  pdfView.io = null;
  pdfView.pages = [];
  pdfView.want.clear();
  pdfView.marks = [];
  pdfView.hover = null;
  pdfView.hoverIdx = -1;
  pdfView.active = -1;
  els.pdf.replaceChildren();
}

function onPdfIntersect(entries) {
  for (const e of entries) {
    if (e.isIntersecting) {
      pdfView.want.add(e.target);
    } else {
      pdfView.want.delete(e.target);
      releasePage(e.target);
    }
  }
  pumpRender();
}

/** Free a page's canvas (and stop drawing it). */
function releasePage(div) {
  if (div._task) div._task.cancel();
  const c = div.querySelector('canvas');
  if (c) { c.width = c.height = 0; c.remove(); }
  div._w = 0;
}

function needsRender(div) {
  if (div._rendering) return false;
  if (!div._w) return true;
  return Math.abs(div.clientWidth - div._w) > div._w * 0.1;   // panel was resized
}

/** Draw wanted pages, closest to the middle of the view first, a couple at a time. */
function pumpRender() {
  while (pdfView.busy < PDF_MAX_RENDERS) {
    const mid = els.pdf.scrollTop + els.pdf.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const div of pdfView.want) {
      if (!needsRender(div)) continue;
      const d = Math.abs(div.offsetTop + div.offsetHeight / 2 - mid);
      if (d < bestD) { bestD = d; best = div; }
    }
    if (!best) return;
    pdfView.busy++;
    renderPage(best)
      .catch(() => { /* cancelled or destroyed */ })
      .finally(() => { pdfView.busy--; pumpRender(); });
  }
}

async function renderPage(div) {
  const pdf = state.pdf;
  const width = div.clientWidth;
  if (!pdf || !width) return;
  div._rendering = true;
  try {
    const page = await pdf.doc.getPage(Number(div.dataset.p));
    if (state.pdf !== pdf || !pdfView.want.has(div)) return;
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width * PDF_DPR) / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    div._task = task;
    await task.promise;
    if (state.pdf !== pdf || !pdfView.want.has(div)) return;
    const old = div.querySelector('canvas');
    if (old) { old.replaceWith(canvas); old.width = old.height = 0; } else div.prepend(canvas);
    div._w = width;
    // The page's own fonts are loaded now: redo its word boxes with real glyph widths.
    refinePage(pdf, Number(div.dataset.p), page).catch(() => {});
  } finally {
    div._rendering = false;
    div._task = null;
  }
}

/**
 * Text-layer PDFs: once a page is drawn, pdf.js has loaded that page's embedded
 * fonts, so its word boxes can be recomputed with the real glyph widths (exact even
 * for justified lines). The words don't change, only their boxes; done once per page.
 */
async function refinePage(pdf, n, page) {
  if (!pdf.textLayer || pdf.refined.has(n) || state.pdf !== pdf || !state.pageRange) return;
  const range = state.pageRange[n];
  if (!range) return;
  pdf.refined.add(n);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  if (state.pdf !== pdf || !state.layout) return;
  const pg = layoutPage(textLayerWords(content, vp, loadedFonts()), n, vp.height / vp.width);
  if (pg.layout.length !== range[1] - range[0]) return;    // shouldn't happen: keep the estimate
  // Layout entries are shared with state.boxes, so updating them updates the marks too.
  for (let k = 0; k < pg.layout.length; k++) state.layout[range[0] + k].r = pg.layout[k].r;
  const cur = state.boxes && state.boxes[state.index];
  if (cur && cur.p === n) { pdfView.active = -1; highlightPdf(); }
  schedulePdfSave();
}

/** Position a box (a word rect in page fractions) inside its page div, in %. */
function placeBox(el, r) {
  el.style.left = `${r[0] * 100}%`;
  el.style.top = `${r[1] * 100}%`;
  el.style.width = `${(r[2] - r[0]) * 100}%`;
  el.style.height = `${(r[3] - r[1]) * 100}%`;
}

function highlightPdf() {
  if (state.panel !== 'pdf' || !state.pdf) return;
  const i = state.index;
  if (pdfView.active === i) return;
  pdfView.active = i;
  const b = state.boxes && state.boxes[i];
  const div = b && pdfView.pages[b.p - 1];
  const rects = div ? b.r : [];
  rects.forEach((r, k) => {
    let m = pdfView.marks[k];
    if (!m) {
      m = document.createElement('div');
      m.className = 'pdf-mark';
      pdfView.marks.push(m);
    }
    if (m.parentNode !== div) div.appendChild(m);
    placeBox(m, r);
    m.hidden = false;
  });
  for (let k = rects.length; k < pdfView.marks.length; k++) pdfView.marks[k].hidden = true;
  if (!rects.length) return;
  // Keep the word in view, scrolling only the panel.
  const pageTop = div.offsetTop, pageH = div.offsetHeight;
  const top = pageTop + rects[0][1] * pageH;
  const bottom = pageTop + rects[rects.length - 1][3] * pageH;
  const st = els.pdf.scrollTop, vh = els.pdf.clientHeight;
  if (top < st + 8 || bottom > st + vh - 8) els.pdf.scrollTop = top - vh / 3;
}

/** Word index under the mouse in the PDF view (or nearest within a few px), else -1. */
function pdfWordAt(e) {
  const div = e.target.closest && e.target.closest('.pdf-page');
  if (!div || !state.pageIdx) return -1;
  const list = state.pageIdx[Number(div.dataset.p)];
  if (!list) return -1;
  const rect = div.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const aspect = rect.height / rect.width;     // measure distances in page-width units
  let best = -1, bestD = Infinity;
  for (const i of list) {
    for (const r of state.boxes[i].r) {
      const dx = x < r[0] ? r[0] - x : x > r[2] ? x - r[2] : 0;
      const dy = (y < r[1] ? r[1] - y : y > r[3] ? y - r[3] : 0) * aspect;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  const tolerance = 6 / rect.width;            // ~6 px
  return bestD <= tolerance * tolerance ? best : -1;
}

function showPdfHover(i) {
  if (i === pdfView.hoverIdx) return;
  pdfView.hoverIdx = i;
  els.pdf.classList.toggle('over-word', i >= 0);
  const b = i >= 0 && state.boxes[i];
  const div = b && pdfView.pages[b.p - 1];
  if (!div || !b.r.length) {
    if (pdfView.hover) pdfView.hover.hidden = true;
    return;
  }
  if (!pdfView.hover) {
    pdfView.hover = document.createElement('div');
    pdfView.hover.className = 'pdf-hover';
  }
  if (pdfView.hover.parentNode !== div) div.appendChild(pdfView.hover);
  placeBox(pdfView.hover, b.r[0]);
  pdfView.hover.hidden = false;
}

// ---------- Right panel: textarea / text view / PDF view ----------
function readingPanel() {
  return state.pdf && state.view === 'pdf' ? 'pdf' : 'text';
}

/** Show the textarea ('edit'), the text view ('text') or the PDF ('pdf'). */
function showPanel(mode) {
  if (mode === 'pdf' && !state.pdf) mode = 'text';
  state.panel = mode;
  els.text.hidden = mode !== 'edit';
  els.doc.hidden = mode !== 'text';
  els.pdf.hidden = mode !== 'pdf';
  els.viewSwitch.hidden = !state.pdf || mode === 'edit';
  els.viewPdf.setAttribute('aria-pressed', String(mode === 'pdf'));
  els.viewText.setAttribute('aria-pressed', String(mode === 'text'));
  els.edit.textContent = mode === 'edit' ? '👁 View text' : '✎ Edit text';
  els.edit.disabled = mode === 'edit' && !state.words.length;
  if (mode === 'text') { docActive = null; highlightDoc(); }
  if (mode === 'pdf') { pdfView.active = -1; highlightPdf(); pumpRender(); }
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

function updatePlayButton() {
  els.play.textContent = state.playing ? '⏸ Pause' : '▶ Play';
}

function remainingText() {
  const left = state.words.length - state.index;
  const mins = left / state.wpm;
  if (mins < 1) return `~${Math.max(1, Math.round(mins * 60))}s left`;
  return `~${Math.round(mins)} min left`;
}

// ---------- Playback ----------
function currentDelay() {
  const base = 60000 / state.wpm;
  const word = state.words[state.index] || '';
  return els.punct.checked ? base * delayMultiplier(word) : base;
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.playing) return;
  state.timer = setTimeout(tick, currentDelay());
}

function tick() {
  if (!state.playing) return;
  if (state.index >= state.words.length - 1) {
    if (state.ocr) {
      // Caught up with the OCR: wait for the next page instead of finishing.
      if (!state.waiting) setStatus('Waiting for the next page (OCR)…');
      state.waiting = true;
      state.timer = setTimeout(tick, 300);
      return;
    }
    finish();
    return;
  }
  if (state.waiting) { state.waiting = false; setStatus(''); }
  state.index++;
  renderCurrent();
  schedule();
}

function play() {
  // Text was edited since it was loaded: load the new version first.
  if (!state.words.length || els.text.value !== state.loadedText) {
    loadText();
    if (!state.words.length) return;
  }
  if (state.finished || (state.index >= state.words.length - 1 && !state.ocr)) {
    state.index = 0;
  }
  state.finished = false;
  state.playing = true;
  updatePlayButton();
  renderCurrent();
  setStatus('');
  schedule();
}

function pause() {
  state.playing = false;
  state.waiting = false;
  clearTimeout(state.timer);
  updatePlayButton();
  if (state.words.length) setStatus(`Paused · ${remainingText()}`);
  saveSettings();
}

function togglePlay() {
  state.playing ? pause() : play();
}

function finish() {
  state.playing = false;
  state.finished = true;
  clearTimeout(state.timer);
  updatePlayButton();
  renderCurrent();
  setStatus('✓ Finished. Press Play or Restart to read again.');
}

function restart() {
  if (!state.words.length) return;
  state.index = 0;
  state.finished = false;
  renderCurrent();
  if (state.playing) schedule();
  else setStatus('Back to the start. Press Play.');
}

function seek(i) {
  if (!state.words.length) return;
  state.index = Math.min(state.words.length - 1, Math.max(0, i));
  state.finished = false;
  renderCurrent();
  if (state.playing) schedule();
  else setStatus(`Paused · ${remainingText()}`);
}

function step(delta) {
  if (state.playing) pause();
  seek(state.index + delta);
}

/** Jump to the start of the previous / next sentence. */
function jumpSentence(dir) {
  if (!state.words.length) return;
  if (state.playing) pause();
  const isEnd = (w) => /[.!?…]["'”’»)\]]*$/u.test(w);
  let i = state.index;
  if (dir < 0) {
    i--; // move off the current word
    while (i > 0 && !isEnd(state.words[i - 1])) i--;
    // If we were already at a sentence start, go to the previous one.
    if (i === state.index - 1 && i > 0) {
      i--;
      while (i > 0 && !isEnd(state.words[i - 1])) i--;
    }
  } else {
    while (i < state.words.length - 1 && !isEnd(state.words[i])) i++;
    i++;
  }
  seek(i);
}

// ---------- Loading text ----------
/**
 * Parse text into state.words and build the text view. `layout` (optional) has one
 * entry per token of `text` with its position in the PDF. Returns removed-junk count.
 */
function setText(text, layout = null) {
  const tokens = parseText(text);
  if (layout && layout.length !== tokens.length) {
    console.warn(`PDF layout mismatch (${layout.length} boxes, ${tokens.length} tokens): no PDF highlighting`);
    layout = null;
  }
  state.words = [];
  state.layout = layout;
  state.boxes = layout ? [] : null;
  state.pageIdx = layout ? [] : null;
  state.pageRange = null;
  if (layout) {             // page -> [first, end) of its entries in layout
    state.pageRange = [];
    layout.forEach((l, k) => {
      const r = state.pageRange[l.p] || (state.pageRange[l.p] = [k, k]);
      r[1] = k + 1;
    });
  }
  addTokens(tokens, layout);
  buildDoc(text, tokens);
  pdfView.active = -1;
  return tokens.length - state.words.length;
}

/** Append the kept tokens to state.words (and their PDF boxes, if any). */
function addTokens(tokens, layout) {
  tokens.forEach((t, k) => {
    if (!t.kept) return;
    if (layout && state.boxes) {
      const b = layout[k];
      (state.pageIdx[b.p] || (state.pageIdx[b.p] = [])).push(state.words.length);
      state.boxes.push(b);
    }
    state.words.push(t.word);
  });
}

/** Add text to the end without touching the position or playback (OCR pages). */
function appendText(chunk, layout = null) {
  const sep = state.loadedText ? '\n\n' : '';
  const tokens = parseText(chunk);
  if (state.layout) {
    if (layout && layout.length === tokens.length) {
      for (const l of layout) state.layout.push(l);
    } else {                    // shouldn't happen; keep reading, just without PDF boxes
      state.layout = state.boxes = state.pageIdx = state.pageRange = null;
    }
  }
  addTokens(tokens, state.layout ? layout : null);
  if (sep) docText.appendChild(document.createTextNode(sep));
  docText.appendChild(docFragment(chunk, tokens));
  state.loadedText += sep + chunk;
  els.text.value = state.loadedText;
  renderProgress();
}

function stopOcr() {
  if (!state.ocr) return;
  fileJob++;                  // the running OCR loop sees this and stops
  state.ocr = null;
}

/**
 * Load the textarea's text into the reader. `layout` is passed when the text comes
 * straight from a PDF; text that no longer matches the PDF detaches it.
 */
function loadText(layout = null) {
  pause();
  const same = state.words.length > 0 && els.text.value === state.loadedText;
  if (!same) stopOcr();       // loading other text replaces the PDF being OCR'd
  if (!layout && same && state.pdf) layout = state.layout;
  if (!layout) detachPdf();
  const removed = setText(els.text.value, layout);
  state.loadedText = els.text.value;
  state.index = 0;
  state.finished = false;
  if (!state.words.length) {
    renderCurrent();
    showPanel('edit');
    setStatus('Nothing to read. Paste some text or open a PDF first.', true);
    return false;
  }
  showPanel(readingPanel());
  renderCurrent();
  const junk = removed ? ` · ${removed} junk removed` : '';
  setStatus(`${state.words.length} words loaded${junk} · ${remainingText()}`);
  saveSettings();
  schedulePdfSave();
  return true;
}

// ---------- PDF: extracting words with their position on the page ----------
async function openPdf(bytes) {
  if (!window.pdfjsLib) {
    throw new Error('PDF library failed to load (are you offline?). Paste the text instead.');
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  // pdf.js may take ownership of the buffer, so give it a copy (the original is saved).
  return pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Turn a page's words [{ str, rects, brk }] into its text plus a layout entry per
 * word. brk is what follows the word: ' ', '\n' or '\n\n'. Lines are reflowed into
 * paragraphs, and words hyphenated across a line break are joined ("exam-" + "ple"
 * -> "example", keeping both boxes). Words never contain whitespace, so the text's
 * \S+ tokens line up 1:1 with the layout entries.
 */
function layoutPage(words, page, aspect = Math.SQRT2) {
  // Line structure first (on the real lines), then join hyphenated words.
  for (const w of words) w.eol = w.brk !== ' ';
  reflowLines(words, aspect);
  const merged = [];
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    while (w.eol && i + 1 < words.length &&
           /\p{L}[-­‐‑¬]$/u.test(w.str) && /^\p{Ll}/u.test(words[i + 1].str)) {
      const n = words[++i];
      w = { str: w.str.slice(0, -1) + n.str, rects: w.rects.concat(n.rects), brk: n.brk, eol: n.eol };
    }
    merged.push(w);
  }
  let text = '';
  const layout = [];
  merged.forEach((w, k) => {
    text += w.str + (k < merged.length - 1 ? w.brk : '');
    layout.push({ p: page, r: w.rects.map((r) => r.map(round4)) });
  });
  return { text, layout };
}

/**
 * Turn the PDF's line breaks into flowing paragraphs for the text view (in place).
 * A line ended only because the next word didn't fit (classic word-wrap test) ->
 * ' '. A bigger vertical gap -> paragraph ('\n\n'). Otherwise (short line: end of
 * paragraph, list item, verse) the line break is kept. `aspect` = page height / width.
 * Only whitespace changes, so the words (and their boxes) stay the same.
 */
function reflowLines(words, aspect) {
  const lines = [];
  let line = null;
  for (const w of words) {
    for (const r of w.rects) {
      if (!line) line = { x0: r[0], y0: r[1], x1: r[2], y1: r[3], first: w, last: null };
      line.x0 = Math.min(line.x0, r[0]); line.y0 = Math.min(line.y0, r[1]);
      line.x1 = Math.max(line.x1, r[2]); line.y1 = Math.max(line.y1, r[3]);
    }
    if (w.brk !== ' ') {
      if (line) { line.last = w; lines.push(line); }
      line = null;
    }
  }
  // Typical gap between consecutive lines on this page (median), to spot paragraph gaps.
  const gaps = [];
  for (let k = 0; k < lines.length - 1; k++) {
    const g = lines[k + 1].y0 - lines[k].y1;
    if (g >= 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : null;

  for (let k = 0; k < lines.length - 1; k++) {
    const L = lines[k], N = lines[k + 1];
    if (L.last.brk === ' ') continue;
    const h = L.y1 - L.y0, hn = N.y1 - N.y0;
    if (!(h > 0) || !(hn > 0)) continue;
    // Right edge of this column: the widest line starting at about the same x.
    let right = L.x1;
    for (const o of lines) if (Math.abs(o.x0 - L.x0) < 0.03 && o.x1 > right) right = o.x1;
    const r0 = N.first.rects[0];
    const nextWord = r0 ? r0[2] - r0[0] : 0;
    const space = 0.25 * h * aspect;          // ~ a space at this font size, in page widths
    // Boxes hug the ink, so allow one space of slack.
    const wrapped = L.x1 + space + nextWord > right - space;
    const newColumn = N.y0 < L.y0 - h * 0.5;  // next line is higher up: another column
    const gap = N.y0 - L.y1;
    const bigGap = lineGap !== null ? gap > lineGap * 1.5 + h * 0.15 : gap > h * 0.7;
    const sizeChange = Math.max(h, hn) / Math.min(h, hn) > 1.4;   // heading / different text
    if (sizeChange || (!newColumn && bigGap)) L.last.brk = '\n\n';
    else if (wrapped) L.last.brk = ' ';
    else L.last.brk = newColumn ? '\n\n' : '\n';
  }
}

/** Relative glyph widths (cached) used to place words inside a pdf.js text item. */
const glyphCache = new Map();
function glyphWidth(ch, family) {
  const key = family + '\u0000' + ch;
  let w = glyphCache.get(key);
  if (w === undefined) {
    measureCtx.font = `100px ${family}`;
    w = measureCtx.measureText(ch).width;
    glyphCache.set(key, w);
  }
  return w;
}

/** Families of the fonts pdf.js has loaded into the page (its embedded PDF fonts). */
function loadedFonts() {
  const set = new Set();
  document.fonts.forEach((f) => { if (f.status === 'loaded') set.add(f.family.replace(/^["']|["']$/g, '')); });
  return set;
}

/**
 * Words with page-fraction boxes from pdf.js text content. pdf.js gives text "items"
 * (runs of text with a position and total width), so each character's position
 * inside an item is estimated from glyph widths. Handles rotated text.
 *
 * Without `fonts`, widths come from a generic font and are spread proportionally
 * (close, not exact). With `fonts` (the PDF's own fonts, loaded once a page is
 * drawn) the real glyph widths are used and whatever is left of the item's width
 * goes to its spaces: that's where justified text puts its extra space.
 */
function textLayerWords(content, vp, fonts = null) {
  const words = [];
  let cur = null;             // word being built
  let prev = null;            // end of the previous item's baseline (for gap detection)
  const W = vp.width, H = vp.height;

  const brk = (type) => {
    if (cur) {
      cur.brk = type;
      words.push(cur);
      cur = null;
    } else if (type !== ' ' && words.length && words[words.length - 1].brk === ' ') {
      words[words.length - 1].brk = type;
    }
  };

  let itemNo = 0;
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;   // marked-content markers
    const str = item.str;
    itemNo++;
    if (str.length) {
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      const size = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 1;
      const dl = Math.hypot(tx[0], tx[1]) || 1;
      const dx = tx[0] / dl, dy = tx[1] / dl;       // reading direction on screen
      const ux = tx[2] / size, uy = tx[3] / size;   // "up" for the glyphs on screen
      const style = content.styles[item.fontName] || {};
      const asc = style.ascent > 0 ? style.ascent : (style.descent < 0 ? 1 + style.descent : 0.8);
      const desc = style.descent < 0 ? -style.descent : Math.max(0.15, 1 - asc);
      const exact = !!(fonts && fonts.has(item.fontName));
      const family = exact ? `"${item.fontName}"` : (style.fontFamily || 'sans-serif');
      const ox = tx[4], oy = tx[5];
      const width = (style.vertical ? item.height : item.width) * vp.scale;

      // Decide if this item continues the previous word, starts a new one or a new line.
      if (prev) {
        const gx = ox - prev.x, gy = oy - prev.y;
        const along = gx * dx + gy * dy;
        const across = gx * ux + gy * uy;
        if (Math.abs(across) > 0.6 * size) brk('\n');
        else if (along > 0.22 * size || along < -0.6 * size) brk(' ');
      }

      const chars = Array.from(str);
      const cw = chars.map((c) => glyphWidth(c, family));
      let total = cw.reduce((a, b) => a + b, 0);
      if (!(total > 0)) { cw.fill(1); total = chars.length; }
      // Advance of each char along the baseline (page units), summing to `width`.
      let adv = cw.map((v) => (width * v) / total);          // proportional
      if (exact) {
        // Real glyph widths at this size (dl = horizontal font scale, includes Tz).
        const natural = (total * dl) / 100;
        const spaces = chars.filter((c) => /\s/.test(c)).length;
        const extra = width - natural;
        if (spaces && extra > -0.02 * width && extra < 0.6 * width) {
          adv = cw.map((v, k) => (v * dl) / 100 + (/\s/.test(chars[k]) ? extra / spaces : 0));
        }
      }
      let u = 0;
      for (let k = 0; k < chars.length; k++) {
        const c = chars[k];
        const w = adv[k];
        if (/\s/.test(c)) {
          brk(' ');
        } else {
          if (!cur) cur = { str: '', rects: [], brk: ' ' };
          cur.str += c;
          // Axis-aligned box of the glyph's (possibly rotated) rectangle, in page fractions.
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const a of [u, u + w]) {
            for (const v of [asc * size, -desc * size]) {
              const px = ox + a * dx + v * ux, py = oy + a * dy + v * uy;
              if (px < x0) x0 = px; if (px > x1) x1 = px;
              if (py < y0) y0 = py; if (py > y1) y1 = py;
            }
          }
          const r = [x0 / W, y0 / H, x1 / W, y1 / H];
          const last = cur.rects[cur.rects.length - 1];
          // Same item, or another item on the same line: grow the box; else start a new one.
          const sameItem = cur.item === itemNo;
          cur.item = itemNo;
          if (last && (sameItem || Math.abs((last[1] + last[3]) - (r[1] + r[3])) < (r[3] - r[1]))) {
            last[0] = Math.min(last[0], r[0]); last[1] = Math.min(last[1], r[1]);
            last[2] = Math.max(last[2], r[2]); last[3] = Math.max(last[3], r[3]);
          } else {
            cur.rects.push(r);
          }
        }
        u += w;
      }
      prev = { x: ox + dx * width, y: oy + dy * width };
    }
    if (item.hasEOL) brk('\n');
  }
  brk('\n');
  return words;
}

/** Text layer of the PDF with word positions (empty for scans, garbage for broken fonts). */
async function readPdf(pdf) {
  const texts = [], layout = [], sizes = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    setStatus(`Reading PDF… page ${p} / ${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
    const content = await page.getTextContent();
    const pg = layoutPage(textLayerWords(content, vp), p, vp.height / vp.width);
    texts.push(pg.text);
    for (const l of pg.layout) layout.push(l);
    page.cleanup();
  }
  return { text: texts.join('\n\n'), layout, sizes };
}

// ---------- OCR (fallback for scanned / broken PDFs) ----------
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const OCR_LANGS = 'spa+eng';
const OCR_SCALE = 2;          // render pages at 2x: better accuracy, still reasonably fast
const OCR_FIRST_PAGES = 3;    // start reading after this many pages; the rest load while you read
let fileJob = 0;              // bumped on every new file so a running OCR stops

/** Load Tesseract.js from the CDN only when OCR is actually needed. */
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('OCR library failed to load (are you offline?).')); };
    document.head.appendChild(s);
  });
}

/** Words with page-fraction boxes from Tesseract's blocks > paragraphs > lines > words. */
function ocrWords(data, cw, ch) {
  const words = [];
  const end = (type) => {
    const last = words[words.length - 1];
    if (last && (type === '\n\n' || last.brk === ' ')) last.brk = type;
  };
  if (Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const w of line.words || []) {
            const str = (w.text || '').replace(/\s+/g, '');
            if (!str) continue;
            const b = w.bbox;
            words.push({ str, rects: [[b.x0 / cw, b.y0 / ch, b.x1 / cw, b.y1 / ch]], brk: ' ' });
          }
          end('\n');
        }
        end('\n\n');
      }
    }
  } else {                      // no word boxes available: text only
    for (const line of (data.text || '').split('\n')) {
      for (const str of tokenize(line)) words.push({ str, rects: [], brk: ' ' });
      end('\n');
    }
  }
  return words;
}

/**
 * Render each page (from `from` on) to a canvas, recognise it and hand
 * onPage({ text, layout }, page, total) each page as soon as it's done.
 * Returns false if cancelled (a newer file or stopOcr()).
 */
async function ocrPdf(pdf, job, onPage, from = 1) {
  if (from === 1) setStatus('Text unreadable: loading OCR…');
  await loadTesseract();
  const n = pdf.numPages;
  let page = 0;
  const worker = await Tesseract.createWorker(OCR_LANGS, 1, {
    logger: (m) => {
      // Once reading has started, progress shows in the counter instead.
      if (job !== fileJob || state.ocr) return;
      if (m.status === 'recognizing text') {
        setStatus(`OCR: page ${page} / ${n} · ${Math.round(m.progress * 100)}%`);
      } else if (page === 0) {
        setStatus(`OCR: ${m.status}…`);   // first run downloads the language data
      }
    },
  });
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (page = from; page <= n; page++) {
      if (job !== fileJob) return false;
      const p = await pdf.getPage(page);
      const viewport = p.getViewport({ scale: OCR_SCALE });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, viewport }).promise;
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      if (job !== fileJob) return false;
      onPage(layoutPage(ocrWords(data, canvas.width, canvas.height), page, canvas.height / canvas.width), page, n);
    }
    return job === fileJob;
  } finally {
    await worker.terminate();
  }
}

/**
 * OCR the PDF and start reading after the first OCR_FIRST_PAGES pages (with words);
 * the rest are appended in the background while you read. With from > 1 it resumes
 * an OCR whose earlier pages are already loaded.
 * Returns null if cancelled, else { started, text, layout } (text/layout only if it
 * finished before reading started).
 */
async function ocrProgressively(pdf, job, from = 1) {
  const texts = [], layout = [];
  let started = from > 1;
  if (started) {
    state.ocr = { page: from - 1, total: pdf.numPages };
    renderProgress();
  }
  const ok = await ocrPdf(pdf, job, (pg, page, total) => {
    if (!started) {
      texts.push(pg.text);
      for (const l of pg.layout) layout.push(l);
      const text = texts.join('\n\n');
      if (page < Math.min(OCR_FIRST_PAGES, total) || !tokenize(text).length || page === total) return;
      if (looksGarbled(text)) throw new Error('Could not get readable text from this file, even with OCR.');
      started = true;
      els.text.value = text;
      loadText(layout);
      state.ocr = { page, total };
      renderProgress();
      setStatus(`${state.words.length} words ready · Press Play. More pages are added while you read.`);
      return;
    }
    // The user edited the text by hand: stop adding pages so their edits aren't overwritten.
    if (els.text.value !== state.loadedText) { stopOcr(); return; }
    appendText(pg.text, pg.layout);
    state.ocr.page = page;
    renderProgress();
    schedulePdfSave();
  }, from);
  if (!ok) return null;
  if (!started) return { started, text: texts.join('\n\n'), layout };
  state.ocr = null;
  renderProgress();
  schedulePdfSave();
  if (!state.playing) setStatus(`OCR finished · ${pdf.numPages} pages · ${state.words.length} words`);
  return { started, text: '', layout: null };
}

/**
 * True when extracted text is mostly lone symbols / single letters ("! \" # $ a %"),
 * which is what PDFs with broken font encoding (no Unicode map) produce.
 */
function looksGarbled(text) {
  const tokens = tokenize(text);
  if (tokens.length < 30) return false;
  const bad = tokens.filter((t) => !/\p{L}{2,}/u.test(t)).length;
  return bad / tokens.length > 0.6;
}

/** Show this PDF in the PDF view and remember it (IndexedDB) for the next visit. */
function attachPdf(doc, sizes, bytes, name) {
  detachPdf();
  // textLayer: words come from the PDF's text (boxes refined per page); false = OCR.
  state.pdf = { doc, sizes, name, textLayer: true, refined: new Set() };
  buildPdfView();
  idbSet('pdf', { name, bytes }).catch(() => {});
}

function detachPdf() {
  if (!state.pdf) return;
  const { doc } = state.pdf;
  state.pdf = null;
  state.layout = state.boxes = state.pageIdx = state.pageRange = null;
  teardownPdfView();
  doc.destroy();
  idbDel('pdf').catch(() => {});
  idbDel('layout').catch(() => {});
}

async function handleFile(file) {
  if (!file) return;
  stopOcr();
  const job = ++fileJob;
  try {
    let text, layout = null;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const bytes = await file.arrayBuffer();
      const pdf = await openPdf(bytes);
      const res = await readPdf(pdf);
      if (job !== fileJob) { pdf.destroy(); return; }
      pause();
      attachPdf(pdf, res.sizes, bytes, file.name);
      ({ text, layout } = res);
      // Scanned (no text layer) or broken font encoding: fall back to OCR automatically.
      if (!tokenize(text).length || looksGarbled(text)) {
        state.pdf.textLayer = false;
        if (state.view === 'pdf') showPanel('pdf');   // show the pages while the OCR starts
        const r = await ocrProgressively(pdf, job);
        if (!r || r.started) return;     // cancelled, or already loaded page by page
        ({ text, layout } = r);          // tiny / blank PDF: finished before reading started
      }
    } else {
      text = await file.text();
    }
    if (job !== fileJob) return;
    els.text.value = text;
    if (!tokenize(text).length || looksGarbled(text)) {
      pause();
      detachPdf();
      showPanel('edit');
      setStatus(tokenize(text).length ? 'Could not get readable text from this file, even with OCR.'
                                      : 'No text found in that file.', true);
      return;
    }
    loadText(layout);
  } catch (err) {
    console.error(err);
    if (job === fileJob) {
      state.ocr = null;
      if (!state.layout) {       // nothing from this PDF got loaded: drop it
        detachPdf();
        showPanel(state.words.length ? 'text' : 'edit');
      }
      renderProgress();
      setStatus(err.message || 'Could not read that file.', true);
    }
  } finally {
    els.file.value = '';
  }
}

// ---------- Speed ----------
function setWpm(v, { save = true } = {}) {
  state.wpm = clampWpm(v);
  els.wpmNum.value = state.wpm;
  els.wpmRange.value = Math.min(Number(els.wpmRange.max), Math.max(Number(els.wpmRange.min), state.wpm));
  els.wpmLabel.textContent = state.wpm;
  // Apply immediately without losing position.
  if (state.playing) schedule();
  if (save) saveSettings();
}

// ---------- Persistence ----------
function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      wpm: state.wpm,
      punct: els.punct.checked,
      text: els.text.value.length < 2_000_000 ? els.text.value : '',
      index: state.index,
      view: state.view,
    }));
  } catch { /* storage full or disabled: ignore */ }
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (s.wpm) setWpm(s.wpm, { save: false });
    if (typeof s.punct === 'boolean') els.punct.checked = s.punct;
    if (s.view === 'pdf' || s.view === 'text') state.view = s.view;
    state.index = s.index || 0;
    if (s.text) {
      els.text.value = s.text;
      setText(s.text);
      state.loadedText = s.text;
      state.index = Math.min(state.index, Math.max(0, state.words.length - 1));
      if (state.words.length) {
        showPanel('text');
        renderCurrent();
        setStatus(`Resumed at word ${state.index + 1}. Press Play.`);
      }
    }
  } catch { /* ignore bad data */ }
}

/*
 * The PDF (bytes) and its text + word boxes are kept in IndexedDB, so the PDF view
 * comes back after a reload. localStorage is too small for PDFs.
 */
let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('word-reader', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}

function idbRun(mode, fn) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}
const idbGet = (key) => idbRun('readonly', (s) => s.get(key));
const idbSet = (key, value) => idbRun('readwrite', (s) => s.put(value, key));
const idbDel = (key) => idbRun('readwrite', (s) => s.delete(key));

/**
 * Save the loaded PDF text + boxes at most every 1.5 s (OCR appends often). A
 * throttle, not a debounce: pages arriving every second must not postpone it forever.
 */
let pdfSaveTimer = 0;
function schedulePdfSave() {
  if (!pdfSaveTimer) pdfSaveTimer = setTimeout(savePdfNow, 1500);
}

function savePdfNow() {
  clearTimeout(pdfSaveTimer);
  pdfSaveTimer = 0;
  if (!state.pdf || !state.layout) return;
  const total = state.pdf.sizes.length;
  idbSet('layout', {
    text: state.loadedText,
    layout: state.layout,
    sizes: state.pdf.sizes,
    textLayer: state.pdf.textLayer,
    total,
    done: state.ocr ? state.ocr.page : total,   // pages already in the text
  }).catch(() => {});
}

/** On startup: bring back the PDF saved with the current text, and finish its OCR. */
async function restorePdf() {
  const job = fileJob;
  let rec, saved;
  try {
    rec = await idbGet('layout');
    if (!rec) return;
    saved = await idbGet('pdf');
  } catch { return; }
  if (!saved || !window.pdfjsLib || !Array.isArray(rec.layout) || !Array.isArray(rec.sizes)) return;
  // Only if the reader still holds that same text (or none: it was too big for localStorage).
  if (state.loadedText && rec.text !== state.loadedText) return;
  const doc = await openPdf(saved.bytes).catch(() => null);
  if (!doc) return;
  if (job !== fileJob || (state.loadedText && rec.text !== state.loadedText) || state.playing) {
    doc.destroy();
    return;
  }
  const index = state.index;
  state.pdf = { doc, sizes: rec.sizes, name: saved.name, textLayer: rec.textLayer !== false, refined: new Set() };
  buildPdfView();
  els.text.value = rec.text;
  setText(rec.text, rec.layout);
  state.loadedText = rec.text;
  state.index = Math.min(index, Math.max(0, state.words.length - 1));
  showPanel(readingPanel());
  renderCurrent();
  setStatus(`Resumed at word ${state.index + 1}. Press Play.` +
            (rec.done < rec.total ? ` OCR continues from page ${rec.done + 1}.` : ''));
  if (rec.done < rec.total) {
    const ocrJob = ++fileJob;
    ocrProgressively(doc, ocrJob, rec.done + 1).catch((err) => {
      console.error(err);
      if (ocrJob === fileJob) { state.ocr = null; renderProgress(); setStatus(err.message, true); }
    });
  }
}

// ---------- Events ----------
els.start.addEventListener('click', () => { if (loadText()) play(); });
els.play.addEventListener('click', togglePlay);
els.restart.addEventListener('click', restart);
els.back.addEventListener('click', () => step(-1));
els.fwd.addEventListener('click', () => step(1));
els.progress.addEventListener('input', () => seek(Number(els.progress.value)));

els.wpmRange.addEventListener('input', () => setWpm(els.wpmRange.value));
els.wpmNum.addEventListener('change', () => setWpm(els.wpmNum.value));
els.wpmNum.addEventListener('input', () => {
  const n = Number(els.wpmNum.value);
  if (n >= WPM_MIN && n <= WPM_MAX) setWpm(n);
});
// Mouse wheel over the speed controls nudges the WPM.
els.speedBox.addEventListener('wheel', (e) => {
  e.preventDefault();
  setWpm(state.wpm + (e.deltaY < 0 ? 10 : -10));
}, { passive: false });

els.punct.addEventListener('change', () => { if (state.playing) schedule(); saveSettings(); });
els.file.addEventListener('change', () => handleFile(els.file.files[0]));

// Click a word in the text panel to jump there.
els.doc.addEventListener('click', (e) => {
  const i = e.target.dataset && e.target.dataset.i;
  if (i !== undefined) seek(Number(i));
});

// PDF view: click a word to jump there; hovering shows which word you'd jump to.
els.pdf.addEventListener('click', (e) => {
  const i = pdfWordAt(e);
  if (i >= 0) seek(i);
});
let hoverFrame = 0;
els.pdf.addEventListener('mousemove', (e) => {
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    showPdfHover(pdfWordAt(e));
  });
});
els.pdf.addEventListener('mouseleave', () => showPdfHover(-1));
els.pdf.addEventListener('scroll', pumpRender, { passive: true });
new ResizeObserver(() => { if (state.panel === 'pdf') pumpRender(); }).observe(els.pdf);

els.viewPdf.addEventListener('click', () => { state.view = 'pdf'; showPanel('pdf'); saveSettings(); });
els.viewText.addEventListener('click', () => { state.view = 'text'; showPanel('text'); saveSettings(); });

els.edit.addEventListener('click', () => {
  if (state.panel === 'edit') {
    // Back to the view; reload only if the text changed.
    if (els.text.value !== state.loadedText) loadText();
    else showPanel(readingPanel());
  } else {
    pause();
    showPanel('edit');
    els.text.focus();
  }
});

// Drag & drop a file anywhere on the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t === els.text || (t.tagName === 'INPUT' && t.type === 'number')) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      e.shiftKey ? jumpSentence(-1) : step(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      e.shiftKey ? jumpSentence(1) : step(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      setWpm(state.wpm + WPM_STEP_KEYS);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setWpm(state.wpm - WPM_STEP_KEYS);
      break;
  }
  // Keep focus off buttons so Space doesn't also "click" them.
  if (t.tagName === 'BUTTON') t.blur();
});

window.addEventListener('resize', () => {
  refreshBaseFont();
  docActive = null;
  pdfView.active = -1;
  renderCurrent();
});
window.addEventListener('beforeunload', () => {
  saveSettings();
  if (pdfSaveTimer) savePdfNow();   // flush a pending save (e.g. OCR pages just added)
});

// ---------- Init ----------
refreshBaseFont();
setWpm(state.wpm, { save: false });
loadSettings();
renderProgress();
restorePdf();
