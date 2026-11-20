// Isomer prototype — zero dependencies, Node >= 20.
// Three pieces that matter: observation contract checks, a declarative detox
// engine, and a graded parity comparator.
//
// Rule ops split into two classes, and the distinction is load-bearing:
//   normalizer  — a function of ONE value, applied before diffing (uuid, decimal, opaque…)
//   comparator  — a relation between TWO values, applied during diffing (instant tolerance)
// Tolerance cannot be a normalizer: any bucketing scheme mis-grades a pair that
// straddles a bucket boundary, so ±2s would silently fail ~60% of the time.

/* ------------------------------------------------------------------ */
/* JSON Pointer (RFC 6901)                                             */
/* ------------------------------------------------------------------ */

export function parsePointer(p) {
  if (typeof p !== 'string') throw new Error(`pointer must be a string: ${p}`);
  if (p === '') return [];
  if (!p.startsWith('/')) throw new Error(`invalid JSON Pointer: ${p}`);
  return p.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function getPath(value, tokens) {
  let cur = value;
  for (const t of tokens) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(t)) return undefined;
      cur = cur[Number(t)];
    } else {
      if (!(t in cur)) return undefined;
      cur = cur[t];
    }
  }
  return cur;
}

const DELETED = Symbol('deleted');

function setPath(root, tokens, value) {
  if (tokens.length === 0) return value;
  const parent = getPath(root, tokens.slice(0, -1));
  const key = tokens[tokens.length - 1];
  if (parent === null || typeof parent !== 'object') return root;
  if (value === DELETED) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  } else if (Array.isArray(parent)) {
    parent[Number(key)] = value;
  } else {
    parent[key] = value;
  }
  return root;
}

// "/items/*/id" -> [["items","0","id"], ["items","1","id"]]
export function expandPointer(root, patternTokens) {
  let frontier = [{ node: root, path: [] }];
  for (const pat of patternTokens) {
    const next = [];
    for (const { node, path } of frontier) {
      if (node === null || typeof node !== 'object') continue;
      let keys;
      if (Array.isArray(node)) keys = node.map((_, i) => String(i));
      else if (pat === '*') keys = Object.keys(node);
      else keys = pat in node ? [pat] : [];
      for (const k of keys) next.push({ node: node[k], path: [...path, k] });
    }
    frontier = next;
  }
  return frontier.map((f) => f.path);
}

/* ------------------------------------------------------------------ */
/* Canonical form (subset of RFC 8785 JCS)                             */
/* ------------------------------------------------------------------ */

export const canonical = (() => {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return (v) => JSON.stringify(walk(v));
})();

export const stableStringify = canonical;

/* ------------------------------------------------------------------ */
/* Detox: normalizer ops                                               */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_RE = /^-?\d+\.\d+$/;

function durationMs(dur) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(String(dur ?? '1s'));
  if (!m) throw new Error(`bad duration: ${dur}`);
  const n = Number(m[1]);
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60000;
}

export const NORMALIZERS = {
  uuid: (v) => (typeof v === 'string' && UUID_RE.test(v) ? '<uuid>' : v),

  decimal: (v, p) => (typeof v === 'string' && MONEY_RE.test(v) ? Number(v).toFixed(p?.scale ?? 2) : v),

  float: (v, p) => (typeof v === 'number' ? Number(v.toFixed(p?.digits ?? 6)) : v),

  opaque: (v) => (v === null || v === undefined || v === '' ? v : '<opaque>'),

  drop: () => DELETED,

  'nil-if-empty': (v) => (v === '' || (Array.isArray(v) && v.length === 0) ? null : v),

  unordered: (v, p) => {
    if (!Array.isArray(v)) return v;
    const key = parsePointer(p?.sortKey ?? '');
    return [...v].sort((a, b) => {
      const ka = canonical(getPath(a, key) ?? null);
      const kb = canonical(getPath(b, key) ?? null);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  },
};

/* ------------------------------------------------------------------ */
/* Detox: comparator ops (relations, not transforms)                   */
/* ------------------------------------------------------------------ */

export const COMPARATORS = {
  instant: (a, b, p) => {
    const ta = typeof a === 'string' ? Date.parse(a) : NaN;
    const tb = typeof b === 'string' ? Date.parse(b) : NaN;
    if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
    return Math.abs(ta - tb) <= durationMs(p?.tolerance);
  },
};

const isComparator = (op) => op in COMPARATORS;

function ruleApplies(rule, request) {
  const m = rule.match;
  if (!m) return true;
  if (m.path && request?.path !== m.path) return false;
  if (m.method && request?.method !== m.method) return false;
  return true;
}

/** Apply normalizer rules. Comparator rules are no-ops here by design. */
export function detox(value, ruleset, request) {
  const active = (ruleset?.rules ?? []).filter((r) => ruleApplies(r, request));
  const ordered = [
    ...active.filter((r) => r.op === 'unordered'),
    ...active.filter((r) => r.op !== 'unordered' && !isComparator(r.op)),
  ];

  let out = structuredClone(value);
  for (const rule of ordered) {
    const op = NORMALIZERS[rule.op];
    if (!op) throw new Error(`unknown detox op: ${rule.op}`);
    for (const tokens of expandPointer(out, parsePointer(rule.pointer))) {
      out = setPath(out, tokens, op(getPath(out, tokens), rule.params));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

export function diffPaths(a, b, prefix = '', out = []) {
  if (canonical(a) === canonical(b)) return out;
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) {
    out.push(prefix === '' ? '/' : prefix);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    const p = `${prefix}/${k}`;
    if (!(k in a) || !(k in b)) out.push(p);
    else diffPaths(a[k], b[k], p, out);
  }
  return out;
}

// A rule covers a path only at the SAME depth. Deliberately not prefix-based:
// a rule on /items must not swallow "one item vanished from the page".
function ruleFor(ruleset, request, path) {
  const tokens = parsePointer(path);
  return (ruleset?.rules ?? []).find((r) => {
    if (!ruleApplies(r, request)) return false;
    const pat = parsePointer(r.pointer);
    if (pat.length !== tokens.length) return false;
    return pat.every((t, i) => t === '*' || t === tokens[i]);
  });
}

/* ------------------------------------------------------------------ */
/* Grading                                                             */
/* ------------------------------------------------------------------ */

/**
 * verify: equal | exact-mismatch | normalized-mismatch | semantic-mismatch
 * Returns the paths that would block a cutover, plus the paths that were
 * neutralised by a rule — a report that hides the latter is a report nobody trusts.
 */
export function grade(obs, ruleset) {
  const rawL = obs.legacy.body ?? null;
  const rawR = obs.shadow.body ?? null;

  if (obs.legacy.body !== undefined && obs.shadow.body !== undefined) {
    const textL = JSON.stringify(rawL);
    const textR = JSON.stringify(rawR);
    if (textL === textR) return { verdict: 'equal', diffs: [], neutralized: [] };
    if (canonical(rawL) === canonical(rawR)) {
      return { verdict: 'exact-mismatch', diffs: [], neutralized: [] };
    }
  }

  const left = detox(rawL, ruleset, obs.request);
  const right = detox(rawR, ruleset, obs.request);
  const all = diffPaths(left, right);

  const semantic = [];
  const neutralized = [];
  for (const path of all) {
    const rule = ruleFor(ruleset, obs.request, path);
    if (!rule) {
      semantic.push(path);
      continue;
    }
    if (isComparator(rule.op)) {
      const a = getPath(rawL, parsePointer(path));
      const b = getPath(rawR, parsePointer(path));
      if (COMPARATORS[rule.op](a, b, rule.params)) neutralized.push(path);
      else semantic.push(path);
      continue;
    }
    // normalizer rule was already applied, yet values still differ
    semantic.push(path);
  }

  semantic.sort();
  neutralized.sort();

  if (semantic.length > 0) {
    return { verdict: 'semantic-mismatch', diffs: semantic, neutralized };
  }
  return { verdict: 'normalized-mismatch', diffs: [], neutralized };
}

/* ------------------------------------------------------------------ */
/* Observation contract (P0 subset, no schema library)                 */
/* ------------------------------------------------------------------ */

const BIG_ID_RE = /^-?\d{1,20}$/;
const MONEY_STR_RE = /^-?(0|[1-9]\d*)\.\d{2}$/;
const OBS_ID_RE = /^obs_[A-Za-z0-9_-]{8,64}$/;

export function validateObservation(obs) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  if (!obs || typeof obs !== 'object') return { ok: false, errors: ['observation must be an object'] };

  need(obs.observationVersion === '1.0', 'observationVersion must be "1.0"');
  need(OBS_ID_RE.test(obs.id ?? ''), 'id must match ^obs_[A-Za-z0-9_-]{8,64}$');
  need(!Number.isNaN(Date.parse(obs.capturedAt ?? '')), 'capturedAt must be a date-time');
  need(!!obs.meta, 'meta is required');
  need(['fixture', 'live'].includes(obs.meta?.replayMode), 'meta.replayMode must be fixture|live');
  need(typeof obs.meta?.importer === 'string' && obs.meta.importer.length > 0, 'meta.importer is required');
  need(/^[A-Z]+$/.test(obs.request?.method ?? ''), 'request.method must be uppercase');
  need((obs.request?.path ?? '').startsWith('/'), 'request.path must start with /');

  for (const side of ['legacy', 'shadow']) {
    const s = obs[side];
    if (!s) { errors.push(`${side} is required`); continue; }
    need(Number.isInteger(s.status) && s.status >= 100 && s.status <= 599, `${side}.status must be 100..599`);
    for (const [name, values] of Object.entries(s.headers ?? {})) {
      need(Array.isArray(values) && values.every((x) => typeof x === 'string'), `${side}.headers["${name}"] must be string[]`);
    }
    for (const w of s.writeSet ?? []) {
      need(typeof w.table === 'string' && w.table.length > 0, `${side}.writeSet.table required`);
      need(['insert', 'update', 'delete'].includes(w.op), `${side}.writeSet.op invalid`);
      need(!!w.pk && Object.keys(w.pk).length > 0, `${side}.writeSet.pk required`);
      need(Object.values(w.pk).every((v) => typeof v === 'string'), `${side}.writeSet.pk values must be strings`);
      if (w.op === 'insert') need('fullRow' in w, `${side} insert requires fullRow`);
      if (w.op === 'update') need(w.patch && Object.keys(w.patch).length > 0, `${side} update requires non-empty patch`);
    }
  }

  // The numbers hazard: a 64-bit id or money must never travel as a JSON number.
  const scan = (v, path) => {
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const p = `${path}/${k}`;
      if (typeof x === 'number' && Number.isInteger(x) && !Number.isSafeInteger(x)) {
        errors.push(`${p}: integer outside the safe range must be a string`);
      }
      if (typeof x === 'string') {
        if (/^(id|.*Id)$/.test(k) && !BIG_ID_RE.test(x) && /^-?\d+$/.test(x)) {
          errors.push(`${p}: id is numeric but not a valid big-id string`);
        }
        if (/^(amount|total)$/i.test(k) && !MONEY_STR_RE.test(x)) {
          errors.push(`${p}: money must match ^-?(0|[1-9]\\d*)\\.\\d{2}$`);
        }
      }
      scan(x, p);
    }
  };
  scan(obs.legacy?.body, 'legacy.body');
  scan(obs.shadow?.body, 'shadow.body');

  return { ok: errors.length === 0, errors };
}