import { interpolate, toCircle, fromCircle } from 'flubber';

// Internal em size used for all path extraction. Rendering scales from this.
export const FONT_UNITS = 100;

// C²-continuous easing: zero velocity *and* zero acceleration at both ends.
export function smootherstep(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const NUM_RE = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

// opentype.js emits only M/L/C/Q/Z with coordinate-pair arguments, so the
// numbers in a contour alternate x,y throughout.
function centroid(contour) {
  const nums = (contour.match(NUM_RE) || []).map(Number);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    sx += nums[i];
    sy += nums[i + 1];
    n += 1;
  }
  return n ? [sx / n, sy / n] : [0, 0];
}

function contoursOf(font, text) {
  const d = font.getPath(text, 0, 0, FONT_UNITS).toPathData(3);
  return d ? d.split(/(?=M)/g) : [];
}

const FLUBBER_OPTS = { maxSegmentLength: 2.5 };
const DOT_RADIUS = 0.6;

function stepInterpolator(from, to) {
  return (t) => (t < 0.5 ? from : to);
}

// Pair contours left-to-right; unmatched contours grow from / shrink to a
// tiny circle at their own centroid so letters appear and vanish smoothly.
function buildInterpolators(font, en, fr) {
  const A = contoursOf(font, en).map((d) => ({ d, c: centroid(d) }));
  const B = contoursOf(font, fr).map((d) => ({ d, c: centroid(d) }));
  A.sort((p, q) => p.c[0] - q.c[0]);
  B.sort((p, q) => p.c[0] - q.c[0]);

  const shared = Math.min(A.length, B.length);
  const interps = [];
  for (let i = 0; i < shared; i++) {
    try {
      interps.push(interpolate(A[i].d, B[i].d, FLUBBER_OPTS));
    } catch {
      interps.push(stepInterpolator(A[i].d, B[i].d));
    }
  }
  for (let i = shared; i < A.length; i++) {
    try {
      interps.push(toCircle(A[i].d, A[i].c[0], A[i].c[1], DOT_RADIUS, FLUBBER_OPTS));
    } catch {
      interps.push(stepInterpolator(A[i].d, ''));
    }
  }
  for (let i = shared; i < B.length; i++) {
    try {
      interps.push(fromCircle(B[i].c[0], B[i].c[1], DOT_RADIUS, B[i].d, FLUBBER_OPTS));
    } catch {
      interps.push(stepInterpolator('', B[i].d));
    }
  }
  return interps;
}

export class WordMorph {
  constructor(font, en, fr) {
    this.font = font;
    this.en = en;
    this.fr = fr;
    this.dEn = font.getPath(en, 0, 0, FONT_UNITS).toPathData(3);
    this.dFr = fr === en ? this.dEn : font.getPath(fr, 0, 0, FONT_UNITS).toPathData(3);
    this.wEn = font.getAdvanceWidth(en, FONT_UNITS);
    this.wFr = fr === en ? this.wEn : font.getAdvanceWidth(fr, FONT_UNITS);
    this._interps = null;
  }

  // Building flubber interpolators is the expensive step; done lazily so the
  // page appears instantly, and pre-warmed from idle callbacks in main.js.
  prepare() {
    if (!this._interps) {
      this._interps = this.en === this.fr ? [] : buildInterpolators(this.font, this.en, this.fr);
    }
    return this;
  }

  // At the endpoints return the exact Bézier outlines so resting text stays
  // crisp; in between return the sampled flubber blend.
  pathAt(t) {
    if (t <= 0 || this.en === this.fr) return this.dEn;
    if (t >= 1) return this.dFr;
    this.prepare();
    let d = '';
    for (const f of this._interps) d += f(t);
    return d;
  }

  widthAt(t) {
    return this.wEn + (this.wFr - this.wEn) * t;
  }
}

// A morph across an ordered chain of same-language words (e.g. near-synonyms:
// cold -> freezing -> harsh -> ...). Reuses WordMorph pairwise for each
// adjacent link, so t sweeps [0, words.length - 1] across the whole chain.
export class ChainMorph {
  constructor(font, words) {
    this.words = words;
    this.segments = [];
    for (let i = 0; i < words.length - 1; i++) {
      this.segments.push(new WordMorph(font, words[i], words[i + 1]));
    }
  }

  prepare() {
    for (const s of this.segments) s.prepare();
    return this;
  }

  pathAt(t) {
    const { i, local } = this._locate(t);
    return this.segments[i].pathAt(local);
  }

  widthAt(t) {
    const { i, local } = this._locate(t);
    return this.segments[i].widthAt(local);
  }

  _locate(t) {
    const n = this.segments.length;
    const clamped = Math.max(0, Math.min(n, t));
    const i = Math.min(n - 1, Math.floor(clamped));
    return { i, local: clamped - i };
  }
}
