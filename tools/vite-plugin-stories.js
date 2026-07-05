// Dev-server side of the story editor. Two endpoints, dev mode only:
//
//   GET  /__magicfont/dict     -> EN->FR lexicon (starter + optional Apertium
//                                 build from `npm run dict`, merged)
//   POST /__magicfont/stories  -> validates a story JSON and writes it to
//                                 src/stories/user/<id>.json, which the app
//                                 picks up through import.meta.glob
//
// Nothing here ships in the production bundle; builds simply include whatever
// user stories exist as files at build time.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isLangPair(v) {
  return v && typeof v.en === 'string' && v.en.trim() && typeof v.fr === 'string' && v.fr.trim();
}

function isToken(t) {
  return t && (t.br === true || (typeof t.en === 'string' && t.en && typeof t.fr === 'string' && t.fr));
}

function validate(story) {
  if (!story || typeof story !== 'object') return 'body is not an object';
  if (typeof story.id !== 'string' || !ID_RE.test(story.id)) return 'id must be a kebab-case slug';
  if (!isLangPair(story.title)) return 'title must be { en, fr }';
  if (!isLangPair(story.genre)) return 'genre must be { en, fr }';
  if (!Array.isArray(story.pages) || !story.pages.length) return 'pages must be a non-empty array';
  for (const page of story.pages) {
    if (!Array.isArray(page) || !page.length) return 'each page must be a non-empty array of paragraphs';
    for (const paragraph of page) {
      if (!Array.isArray(paragraph) || !paragraph.length) return 'each paragraph must be a non-empty token array';
      if (!paragraph.every(isToken)) return 'tokens must be { en, fr } or { br: true }';
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

export function storiesPlugin() {
  let root = process.cwd();

  return {
    name: 'magic-font-stories',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use('/__magicfont/dict', (req, res) => {
        const dict = {};
        for (const file of ['tools/dict/starter-en-fr.json', 'tools/dict/en-fr.json']) {
          const path = join(root, file);
          if (!existsSync(path)) continue;
          try {
            Object.assign(dict, JSON.parse(readFileSync(path, 'utf8')));
          } catch (err) {
            server.config.logger.warn(`[stories] could not read ${file}: ${err.message}`);
          }
        }
        sendJson(res, 200, dict);
      });

      server.middlewares.use('/__magicfont/stories', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' });
          return;
        }
        try {
          const story = JSON.parse(await readBody(req));
          const error = validate(story);
          if (error) {
            sendJson(res, 400, { error });
            return;
          }
          const dir = join(root, 'src/stories/user');
          await mkdir(dir, { recursive: true });
          // Never overwrite silently: bump a numeric suffix until free.
          let id = story.id;
          for (let n = 2; existsSync(join(dir, `${id}.json`)); n++) {
            id = `${story.id}-${n}`;
          }
          story.id = id;
          await writeFile(join(dir, `${id}.json`), JSON.stringify(story, null, 2) + '\n');
          sendJson(res, 200, { id });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
      });
    },
  };
}
