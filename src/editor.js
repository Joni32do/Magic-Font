// Story editor, dev mode only (dynamically imported behind import.meta.env.DEV).
//
// Write or import English text, let the bundled EN->FR lexicon draft a French
// version word by word (a draft to correct, not a translation - word-level
// dictionaries know nothing about sense or idiom), then save. The dev server
// writes the story to src/stories/user/<id>.json and the page reloads with it.
//
// Text conventions in both textareas:
//   blank line          new paragraph
//   line with only ---  page break; two or more pages make a "book" with
//                       page turning in the reader
//
// The FR draft mirrors the EN text line by line, so paragraphs and page
// breaks stay aligned while you fix the wording. Tokens are paired by
// position within each paragraph (per line in verse mode, so line breaks
// survive as { br: true } tokens).

let dictPromise = null;

function loadDict() {
  dictPromise ??= fetch('/__magicfont/dict').then((r) => {
    if (!r.ok) throw new Error(`dictionary request failed: ${r.status}`);
    return r.json();
  });
  return dictPromise;
}

// Split a token into leading punctuation, the word core, and trailing
// punctuation, so "moon." translates its core and keeps the period.
const TOKEN_RE = /^([^\p{L}]*)([\p{L}'’-]*)(.*)$/u;

function lookup(dict, word) {
  const lower = word.toLowerCase();
  if (dict[lower]) return dict[lower];
  // The lexicon holds lemmas; try a few cheap de-inflections.
  const tries = [];
  if (lower.endsWith('ies')) tries.push(lower.slice(0, -3) + 'y');
  if (lower.endsWith('es')) tries.push(lower.slice(0, -2));
  if (lower.endsWith('s')) tries.push(lower.slice(0, -1));
  if (lower.endsWith('ed')) tries.push(lower.slice(0, -2), lower.slice(0, -1));
  if (lower.endsWith('ing')) tries.push(lower.slice(0, -3), lower.slice(0, -3) + 'e');
  for (const t of tries) {
    if (dict[t]) return dict[t];
  }
  return null;
}

function translateToken(dict, token) {
  const [, pre, core, post] = token.match(TOKEN_RE);
  if (!core) return token;
  let fr = lookup(dict, core);
  if (!fr) return token; // unknown word: keep EN so the token morphs to itself
  if (core[0] === core[0].toUpperCase() && core[0] !== core[0].toLowerCase()) {
    fr = fr[0].toUpperCase() + fr.slice(1);
  }
  return pre + fr + post;
}

function translateLine(dict, line) {
  if (isPageBreak(line)) return line.trim();
  return line
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => translateToken(dict, tok))
    .join(' ');
}

const isPageBreak = (line) => /^\s*-{3,}\s*$/.test(line);

// Parse a textarea into pages -> paragraphs -> lines of token strings.
function parseText(text) {
  const pages = [[]];
  let paragraph = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (isPageBreak(raw)) {
      pages.push([]);
      paragraph = null;
      continue;
    }
    const line = raw.trim();
    if (!line) {
      paragraph = null;
      continue;
    }
    if (!paragraph) {
      paragraph = [];
      pages[pages.length - 1].push(paragraph);
    }
    paragraph.push(line.split(/\s+/));
  }
  return pages.filter((page) => page.length);
}

// Zip EN and FR token lists positionally. Count mismatches are survivable:
// missing FR words fall back to the EN word, extra FR words merge into the
// last token. Returns tokens plus a warning flag.
function zipTokens(enWords, frWords) {
  const tokens = enWords.map((en, k) => ({ en, fr: frWords[k] || en }));
  if (frWords.length > enWords.length && tokens.length) {
    tokens[tokens.length - 1].fr += ' ' + frWords.slice(enWords.length).join(' ');
  }
  return { tokens, mismatch: enWords.length !== frWords.length };
}

// Build story pages from both texts. In verse mode lines are paired one to
// one and separated by { br: true }; otherwise a paragraph is one flat list.
function buildPages(enText, frText, verse) {
  const enPages = parseText(enText);
  const frPages = parseText(frText || enText);
  const warnings = [];
  let pIndex = 0;

  const pages = enPages.map((enPage, pg) => {
    const frPage = frPages[pg] || [];
    return enPage.map((enPar, i) => {
      pIndex += 1;
      const frPar = frPage[i] || [];
      const tokens = [];
      let mismatch = false;

      if (verse) {
        enPar.forEach((enLine, li) => {
          if (li) tokens.push({ br: true });
          const zipped = zipTokens(enLine, frPar[li] || []);
          tokens.push(...zipped.tokens);
          mismatch ||= zipped.mismatch || !frPar[li];
        });
        mismatch ||= frPar.length > enPar.length;
      } else {
        const zipped = zipTokens(enPar.flat(), frPar.flat());
        tokens.push(...zipped.tokens);
        mismatch = zipped.mismatch;
      }

      if (mismatch) warnings.push(pIndex);
      return tokens;
    });
  });

  return { pages, warnings };
}

function slugify(text) {
  return (
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'story'
  );
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

let overlay = null;

export function openEditor() {
  if (overlay) return;
  overlay = el('div', 'editor-overlay');
  const panel = el('div', 'editor-panel');
  overlay.appendChild(panel);

  const head = el('div', 'editor-head');
  head.appendChild(el('h2', null, 'new story'));
  const close = el('button', 'editor-close', 'x');
  close.type = 'button';
  close.title = 'close';
  head.appendChild(close);
  panel.appendChild(head);

  panel.appendChild(
    el(
      'p',
      'editor-hint',
      'Write English below (blank line = new paragraph, a line with only --- = page break; ' +
        'several pages make a book). "draft french" fills the right side word by word from ' +
        'the dictionary - fix it before saving.'
    )
  );

  const meta = el('div', 'editor-meta');
  const fields = {};
  for (const [key, placeholder] of [
    ['titleEn', 'title (english)'],
    ['titleFr', 'titre (french)'],
    ['genreEn', 'genre, e.g. a fable'],
    ['genreFr', 'genre, e.g. une fable'],
  ]) {
    const input = el('input');
    input.type = 'text';
    input.placeholder = placeholder;
    fields[key] = input;
    meta.appendChild(input);
  }
  panel.appendChild(meta);

  const texts = el('div', 'editor-texts');
  const enArea = el('textarea');
  enArea.placeholder = 'Once upon a time...';
  const frArea = el('textarea');
  frArea.placeholder = 'Il etait une fois... (or press "draft french")';
  texts.appendChild(enArea);
  texts.appendChild(frArea);
  panel.appendChild(texts);

  const row = el('div', 'editor-actions');
  const importBtn = el('button', null, 'import .txt');
  const draftBtn = el('button', null, 'draft french');
  const verseLabel = el('label', 'editor-verse');
  const verseBox = el('input');
  verseBox.type = 'checkbox';
  verseLabel.appendChild(verseBox);
  verseLabel.appendChild(document.createTextNode(' verse'));
  const saveBtn = el('button', 'editor-save', 'save story');
  for (const b of [importBtn, draftBtn, saveBtn]) b.type = 'button';
  row.appendChild(importBtn);
  row.appendChild(draftBtn);
  row.appendChild(verseLabel);
  row.appendChild(saveBtn);
  panel.appendChild(row);

  const status = el('p', 'editor-status');
  panel.appendChild(status);

  const file = el('input');
  file.type = 'file';
  file.accept = '.txt,text/plain';
  file.hidden = true;
  panel.appendChild(file);

  const say = (msg, isError) => {
    status.textContent = msg;
    status.classList.toggle('error', Boolean(isError));
  };

  const closeEditor = () => {
    overlay.remove();
    overlay = null;
  };
  close.addEventListener('click', closeEditor);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditor();
  });

  importBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    enArea.value = (await f.text()).replace(/\r\n?/g, '\n').trim();
    if (!fields.titleEn.value) {
      fields.titleEn.value = f.name
        .replace(/\.txt$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
    }
    const pages = parseText(enArea.value).length;
    say(`imported "${f.name}" (${pages} page${pages === 1 ? '' : 's'})`);
    draftBtn.click();
  });

  draftBtn.addEventListener('click', async () => {
    if (!enArea.value.trim()) {
      say('nothing to draft: the english side is empty', true);
      return;
    }
    say('drafting...');
    try {
      const dict = await loadDict();
      frArea.value = enArea.value
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => translateLine(dict, line))
        .join('\n');
      if (!fields.titleFr.value && fields.titleEn.value) {
        fields.titleFr.value = translateLine(dict, fields.titleEn.value);
      }
      if (!fields.genreFr.value && fields.genreEn.value) {
        fields.genreFr.value = translateLine(dict, fields.genreEn.value);
      }
      say('french drafted word by word - unknown words kept in english, please review');
    } catch (err) {
      say(err.message, true);
    }
  });

  saveBtn.addEventListener('click', async () => {
    const titleEn = fields.titleEn.value.trim();
    if (!titleEn) {
      say('a title is required', true);
      return;
    }
    const { pages, warnings } = buildPages(enArea.value, frArea.value, verseBox.checked);
    if (!pages.length) {
      say('the story text is empty', true);
      return;
    }
    const story = {
      id: slugify(titleEn),
      genre: {
        en: fields.genreEn.value.trim() || (pages.length > 1 ? 'a book' : 'a story'),
        fr: fields.genreFr.value.trim() || (pages.length > 1 ? 'un livre' : 'une histoire'),
      },
      title: { en: titleEn, fr: fields.titleFr.value.trim() || titleEn },
      pages,
    };
    if (verseBox.checked) story.verse = true;

    if (warnings.length && !saveBtn.dataset.confirmed) {
      saveBtn.dataset.confirmed = '1';
      say(
        `word counts differ in paragraph${warnings.length === 1 ? '' : 's'} ${warnings.join(', ')} ` +
          '(extra french words were merged, missing ones fall back to english) - press save again to keep it',
        true
      );
      return;
    }

    say('saving...');
    try {
      const res = await fetch('/__magicfont/stories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(story),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `save failed: ${res.status}`);
      const url = new URL(location);
      url.searchParams.set('story', out.id);
      location.href = url; // full reload so the glob import picks up the new file
    } catch (err) {
      delete saveBtn.dataset.confirmed;
      say(err.message, true);
    }
  });

  // Editing after a mismatch warning re-arms the confirmation.
  for (const area of [enArea, frArea]) {
    area.addEventListener('input', () => delete saveBtn.dataset.confirmed);
  }

  document.body.appendChild(overlay);
  fields.titleEn.focus();
}
