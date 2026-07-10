import { parse } from 'opentype.js';
import { WordMorph, ChainMorph, smootherstep, FONT_UNITS } from './morph.js';
import { allStories, userStories, pagesOf } from './stories.js';
import './style.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

const INK = [31, 26, 20];
const BLEU = [23, 62, 150];
const MUTED_INK = [138, 127, 109];
const MUTED_BLEU = [110, 128, 176];

const MORPH_MS = 700;
const AMBIENT_HOLD_MS = 2600;
const AMBIENT_EVERY_MS = 1500;
const SYNONYM_CHANCE = 0.5; // ambient drift: fraction of holds that wander a synonym chain instead of flipping language
const HOVER_LEAVE_COOLDOWN_MS = 160; // debounce pointerleave so a resizing hover box doesn't flicker in/out
const FADE_MS = 250;
const TITLE_PX = 44;
const GENRE_PX = 16;
const BODY_PX = 27;
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

const words = [];
let modeTarget = 0; // 0 = story rests in English, 1 = story rests in French
let modeLocal = 0; // linear progress toward modeTarget; smootherstep(modeLocal) is the eased baseline language position

function mixColor(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function makeWord(font, metrics, token, sizePx, colors = [INK, BLEU]) {
  const morph = new WordMorph(font, token.en, token.fr);
  // Optional same-language chain (e.g. cold -> freezing -> harsh -> ...) that
  // ambient drift wanders through instead of flipping EN/FR.
  const chain = token.synonyms && token.synonyms.length
    ? new ChainMorph(font, [token.en, ...token.synonyms])
    : null;
  const inkFill = `rgb(${colors[0][0]},${colors[0][1]},${colors[0][2]})`;
  const scale = sizePx / FONT_UNITS;
  const heightPx = (metrics.asc + metrics.desc) * scale;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('word');
  svg.setAttribute('height', heightPx);
  svg.style.overflow = 'visible';
  svg.style.verticalAlign = `${-metrics.desc * scale}px`;

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', `translate(0 ${metrics.asc * scale}) scale(${scale})`);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill-rule', 'evenodd');
  g.appendChild(path);
  svg.appendChild(g);

  const word = {
    morph,
    chain,
    svg,
    path,
    scale,
    colors,
    local: 0, // linear progress of the hover/pin/ambient language-flip animation
    synLocal: 0, // linear progress of the ambient synonym-chain drift
    synTarget: 1, // chain index (1..segments.length) the current drift heads to
    chainActive: false, // true while rendering from the chain instead of morph
    hover: false,
    pinned: false,
    ambientUntil: 0,
    ambientSynonym: false,
    leaveTimer: null,
    lastKey: null,
    render(t) {
      const key = (this.chainActive ? 'c' : 't') + t;
      if (key === this.lastKey) return;
      this.lastKey = key;
      const source = this.chainActive ? this.chain : this.morph;
      this.path.setAttribute('d', source.pathAt(t));
      this.svg.setAttribute('width', Math.max(1, source.widthAt(t) * this.scale));
      this.path.setAttribute('fill', this.chainActive ? inkFill : mixColor(this.colors[0], this.colors[1], t));
    },
  };

  // pointerleave doesn't flip hover off immediately: as a word's box resizes
  // mid-morph the cursor can end up briefly outside it, firing a spurious
  // leave/enter pair every frame (visible as flicker). Debouncing the leave
  // means only a *sustained* exit starts the reverse animation.
  svg.addEventListener('pointerenter', () => {
    clearTimeout(word.leaveTimer);
    word.leaveTimer = null;
    word.hover = true;
    wake();
  });
  svg.addEventListener('pointerleave', () => {
    clearTimeout(word.leaveTimer);
    word.leaveTimer = setTimeout(() => {
      word.hover = false;
      wake();
    }, HOVER_LEAVE_COOLDOWN_MS);
  });
  svg.addEventListener('click', () => {
    word.pinned = !word.pinned;
    svg.classList.toggle('pinned', word.pinned);
    wake();
  });

  word.render(0);
  return word;
}

// The loop runs only while something is animating (or an ambient hold is
// pending) and goes fully idle otherwise; events call wake() to restart it.
// Each word flips toward the language OPPOSITE the story's current baseline
// (set by the EN/FR button), so in French mode a hover melts a word back
// into English.
let rafId = null;
let last = 0;

function tick(now) {
  const dt = Math.min(50, now - last);
  last = now;
  const step = dt / MORPH_MS;
  let active = false;

  if (modeLocal !== modeTarget) {
    modeLocal = modeTarget > modeLocal ? Math.min(modeTarget, modeLocal + step) : Math.max(modeTarget, modeLocal - step);
    active = true;
  }
  const langT = smootherstep(modeLocal);
  const opposite = langT < 0.5 ? 1 : 0;

  for (const w of words) {
    const ambient = now < w.ambientUntil;

    if (w.ambientSynonym) {
      const target = ambient ? 1 : 0;
      if (w.synLocal !== target) {
        w.synLocal = target > w.synLocal ? Math.min(target, w.synLocal + step) : Math.max(target, w.synLocal - step);
      }
      w.chainActive = true;
      w.render(smootherstep(w.synLocal) * w.synTarget);
      if (ambient || w.synLocal !== target) {
        active = true;
      } else {
        w.ambientSynonym = false; // settled back at the root word
      }
      continue;
    }

    w.chainActive = false;
    const target = w.hover || w.pinned || ambient ? 1 : 0;
    if (w.local !== target) {
      w.local = target > w.local ? Math.min(target, w.local + step) : Math.max(target, w.local - step);
    }
    if (ambient || w.local !== target) active = true;
    w.render(langT + (opposite - langT) * smootherstep(w.local));
  }
  rafId = active ? requestAnimationFrame(tick) : null;
}

function wake() {
  if (rafId === null) {
    last = performance.now();
    rafId = requestAnimationFrame(tick);
  }
}

// Pre-build the flubber interpolators in small timed chunks after load, so
// the first click doesn't have to build all of them in a single frame.
function prewarm() {
  const queue = [];
  for (const w of words) {
    queue.push(w.morph);
    if (w.chain) queue.push(w.chain);
  }
  const build = () => {
    const start = performance.now();
    while (queue.length && performance.now() - start < 6) {
      queue.shift().prepare();
    }
    if (queue.length) setTimeout(build, 40);
  };
  setTimeout(build, 200);
}

// Words before this index in `words` belong to the genre/title header and
// survive page turns; buildPage only swaps out everything after it.
let headerWordCount = 0;

function buildPage(font, metrics, story, pageIdx) {
  words.length = headerWordCount;

  const pages = pagesOf(story);
  const storyEl = document.getElementById('story');
  storyEl.textContent = '';
  for (const paragraph of pages[pageIdx]) {
    const p = document.createElement('p');
    if (story.verse) p.classList.add('verse');
    for (const token of paragraph) {
      if (token.br) {
        p.appendChild(document.createElement('br'));
        continue;
      }
      const w = makeWord(font, metrics, token, BODY_PX);
      words.push(w);
      p.appendChild(w.svg);
      p.appendChild(document.createTextNode(' '));
    }
    storyEl.appendChild(p);
  }

  const pager = document.getElementById('pager');
  pager.hidden = pages.length < 2;
  if (!pager.hidden) {
    document.getElementById('page-label').textContent = `page ${pageIdx + 1} / ${pages.length}`;
    document.getElementById('page-prev').disabled = pageIdx === 0;
    document.getElementById('page-next').disabled = pageIdx === pages.length - 1;
  }

  wake();
  prewarm();
}

function buildStory(font, metrics, story, pageIdx = 0) {
  words.length = 0;

  const genreEl = document.getElementById('genre');
  genreEl.textContent = '';
  const genreWord = makeWord(font, metrics, story.genre, GENRE_PX, [MUTED_INK, MUTED_BLEU]);
  words.push(genreWord);
  genreEl.appendChild(genreWord.svg);

  const titleEl = document.getElementById('title');
  titleEl.textContent = '';
  const titleWord = makeWord(font, metrics, story.title, TITLE_PX);
  words.push(titleWord);
  titleEl.appendChild(titleWord.svg);

  headerWordCount = words.length;
  buildPage(font, metrics, story, pageIdx);
}

async function main() {
  const res = await fetch(`${import.meta.env.BASE_URL}fonts/EBGaramond-Regular.ttf`);
  const font = parse(await res.arrayBuffer());
  const upm = font.unitsPerEm;
  const metrics = {
    asc: (font.ascender / upm) * FONT_UNITS,
    desc: (-font.descender / upm) * FONT_UNITS,
  };

  const params = new URLSearchParams(location.search);
  let current = Math.max(0, allStories.findIndex((s) => s.id === params.get('story')));
  let currentPage = 0;

  // --- library panel ---
  const library = document.getElementById('library');
  const toggle = document.getElementById('library-toggle');
  const items = [];

  const addItem = (s, i, parent) => {
    const btn = document.createElement('button');
    btn.className = 'story-item';
    btn.innerHTML =
      `<span class="num">${ROMAN[i] || i + 1}</span>` +
      `<span class="titles">${s.title.en} <span class="dot">·</span> ${s.title.fr}</span>` +
      `<span class="tag">${s.genre.en}</span>`;
    btn.addEventListener('click', () => selectStory(i));
    parent.appendChild(btn);
    items.push(btn);
  };

  const builtinCount = allStories.length - userStories.length;
  allStories.slice(0, builtinCount).forEach((s, i) => addItem(s, i, library));

  // User-written stories and books get their own shelf below the built-ins,
  // collapsed by default behind a "your stories" toggle.
  let userShelf = library;
  if (userStories.length) {
    const divider = document.createElement('button');
    divider.type = 'button';
    divider.className = 'library-divider';
    divider.setAttribute('aria-expanded', 'false');
    divider.innerHTML = 'your stories <span class="chev">⌄</span>';
    library.appendChild(divider);

    userShelf = document.createElement('div');
    userShelf.className = 'user-shelf';
    library.appendChild(userShelf);
    userStories.forEach((s, j) => addItem(s, builtinCount + j, userShelf));

    const setShelf = (open) => {
      userShelf.classList.toggle('open', open);
      divider.classList.toggle('open', open);
      divider.setAttribute('aria-expanded', String(open));
    };
    divider.addEventListener('click', () => setShelf(!userShelf.classList.contains('open')));
    // Start expanded only when the current story lives on this shelf.
    if (current >= builtinCount) setShelf(true);
  }

  // The editor only exists on the dev server (it writes files through a Vite
  // middleware), so the "+" is dev-only and the chunk never ships in builds.
  if (import.meta.env.DEV) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add-story';
    add.textContent = '+';
    add.title = 'write a new story';
    add.setAttribute('aria-label', 'write a new story');
    add.addEventListener('click', async () => {
      const { openEditor } = await import('./editor.js');
      closeLibrary();
      openEditor();
    });
    userShelf.appendChild(add);
  }

  const markCurrent = () => items.forEach((b, i) => b.classList.toggle('current', i === current));

  const closeLibrary = () => {
    library.classList.remove('open');
    toggle.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', () => {
    const open = library.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  const fadeTargets = ['genre', 'title', 'story'].map((id) => document.getElementById(id));

  function selectStory(i) {
    closeLibrary();
    if (i === current) return;
    current = i;
    currentPage = 0;
    markCurrent();
    const url = new URL(location);
    url.searchParams.set('story', allStories[i].id);
    history.replaceState(null, '', url);
    fadeTargets.forEach((el) => el.classList.add('fading'));
    setTimeout(() => {
      buildStory(font, metrics, allStories[i]);
      fadeTargets.forEach((el) => el.classList.remove('fading'));
    }, FADE_MS);
  }

  // --- page turning (books: user stories with more than one page) ---
  const storyEl = document.getElementById('story');
  const turnPage = (delta) => {
    const pages = pagesOf(allStories[current]);
    const next = currentPage + delta;
    if (next < 0 || next >= pages.length) return;
    currentPage = next;
    storyEl.classList.add('fading');
    setTimeout(() => {
      buildPage(font, metrics, allStories[current], currentPage);
      storyEl.classList.remove('fading');
    }, FADE_MS);
  };
  document.getElementById('page-prev').addEventListener('click', () => turnPage(-1));
  document.getElementById('page-next').addEventListener('click', () => turnPage(1));
  document.addEventListener('keydown', (e) => {
    // Leave typing (editor fields) and modified shortcuts alone.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, .editor-overlay')) return;
    if (e.key === 'ArrowLeft') turnPage(-1);
    else if (e.key === 'ArrowRight') turnPage(1);
  });

  // --- ambient drift (off by default; toggled by the "ambient" button) ---
  const ambientToggle = document.getElementById('ambient-toggle');
  let ambientTimer = null;
  ambientToggle.addEventListener('click', () => {
    const on = ambientToggle.classList.toggle('active');
    ambientToggle.setAttribute('aria-pressed', String(on));
    if (on) {
      ambientTimer = setInterval(() => {
        if (!words.length) return;
        const w = words[Math.floor(Math.random() * words.length)];
        if (!w.pinned) {
          w.ambientUntil = performance.now() + AMBIENT_HOLD_MS;
          w.ambientSynonym = Boolean(w.chain) && Math.random() < SYNONYM_CHANCE;
          if (w.ambientSynonym) {
            w.synTarget = 1 + Math.floor(Math.random() * w.chain.segments.length);
          }
          wake();
        }
      }, AMBIENT_EVERY_MS);
    } else {
      clearInterval(ambientTimer);
    }
  });

  // --- EN / FR baseline toggle ---
  const langToggle = document.getElementById('lang-toggle');
  langToggle.addEventListener('click', () => {
    modeTarget = modeTarget === 0 ? 1 : 0;
    langToggle.textContent = modeTarget === 0 ? 'EN' : 'FR';
    wake();
  });

  markCurrent();
  buildStory(font, metrics, allStories[current]);
}

main().catch((err) => {
  document.getElementById('story').textContent = `Failed to load: ${err.message}`;
  console.error(err);
});
