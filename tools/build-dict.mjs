// Build an EN -> FR word lexicon for the story editor's draft translations.
//
// Downloads the Apertium fra-eng bilingual dictionary (GPL-3.0) and converts
// it to a flat JSON map at tools/dict/en-fr.json. That file is gitignored on
// purpose: this repository is MIT-licensed, so the GPL dictionary data is
// fetched locally by whoever wants draft translations instead of being
// committed. Without it the editor falls back to the small MIT-licensed
// starter lexicon in tools/dict/starter-en-fr.json.
//
// Usage: npm run dict

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIX_URL =
  'https://raw.githubusercontent.com/apertium/apertium-fra-eng/master/apertium-fra-eng.fra-eng.dix';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dict');
const dixPath = join(outDir, 'apertium-fra-eng.dix');
const jsonPath = join(outDir, 'en-fr.json');

// In the .dix the LEFT side is French and the RIGHT side is English.
// r="LR" entries are valid only fra->eng, so they are useless for our
// eng->fra lookup direction and get skipped.
function convert(xml) {
  const map = {};
  let kept = 0;
  for (const m of xml.matchAll(/<e\b([^>]*)>(.*?)<\/e>/gs)) {
    const attrs = m[1];
    const body = m[2];
    if (/r="LR"/.test(attrs)) continue;

    let fr;
    let en;
    const pair = body.match(/<l>(.*?)<\/l>.*?<r>(.*?)<\/r>/s);
    const ident = body.match(/<i>(.*?)<\/i>/s);
    if (pair) {
      [, fr, en] = pair;
    } else if (ident) {
      fr = en = ident[1];
    } else {
      continue;
    }

    fr = clean(fr);
    en = clean(en);
    if (!en || !fr) continue;
    if (en.includes(' ')) continue; // lookups are per single English token

    const key = en.toLowerCase();
    if (!(key in map)) {
      map[key] = fr;
      kept += 1;
    }
  }
  console.log(`kept ${kept} en->fr pairs`);
  return map;
}

function clean(s) {
  return s
    .replace(/<b\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  await mkdir(outDir, { recursive: true });
  let xml;
  if (existsSync(dixPath)) {
    console.log(`using cached ${dixPath}`);
    xml = await readFile(dixPath, 'utf8');
  } else {
    console.log(`downloading ${DIX_URL} ...`);
    const res = await fetch(DIX_URL);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    xml = await res.text();
    await writeFile(dixPath, xml);
  }
  const map = convert(xml);
  await writeFile(jsonPath, JSON.stringify(map, null, 1));
  console.log(`wrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
