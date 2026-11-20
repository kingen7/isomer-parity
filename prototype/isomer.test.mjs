import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePointer,
  expandPointer,
  detox,
  grade,
  stableStringify,
  validateObservation,
} from './isomer.mjs';
import { ruleset, cases } from './corpus.mjs';

/* ---------- pointer ---------- */

test('pointer parsing follows RFC 6901', () => {
  assert.deepEqual(parsePointer('/a/b/0'), ['a', 'b', '0']);
  assert.deepEqual(parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']);
  assert.deepEqual(parsePointer(''), []);
  assert.throws(() => parsePointer('a/b'));
});

test('wildcard expansion stops at scalars', () => {
  const doc = { items: [{ id: 'x' }, { id: 'y' }], other: 1 };
  assert.deepEqual(expandPointer(doc, parsePointer('/items/*/id')), [
    ['items', '0', 'id'],
    ['items', '1', 'id'],
  ]);
  assert.deepEqual(expandPointer(doc, parsePointer('/missing/*')), []);
});

/* ---------- normalisation ---------- */

test('detox never mutates the input', () => {
  const doc = { orderId: '0f8fad5b-d9cb-469f-a165-70867728950e' };
  const before = structuredClone(doc);
  detox(doc, ruleset);
  assert.deepEqual(doc, before);
});

test('unordered sort is stable and order independent', () => {
  const a = { items: [{ sku: 'b' }, { sku: 'a' }] };
  const b = { items: [{ sku: 'a' }, { sku: 'b' }] };
  assert.equal(stableStringify(detox(a, ruleset)), stableStringify(detox(b, ruleset)));
});

test('instant tolerance is a comparator, not a normalizer', () => {
  const near = detox({ createdAt: '2026-11-20T10:00:00Z' }, ruleset);
  assert.equal(near.createdAt, '2026-11-20T10:00:00Z'); // untouched

  const obs = (a, b) => ({
    observationVersion: '1.0',
    id: 'obs_abcdefgh12345678',
    capturedAt: '2026-11-20T10:00:00.000Z',
    meta: { replayMode: 'fixture', importer: 'prototype@0' },
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: { createdAt: a } },
    shadow: { status: 200, body: { createdAt: b } },
  });
  assert.equal(grade(obs('2026-11-20T10:00:00.000Z', '2026-11-20T10:00:01.900Z'), ruleset).verdict, 'normalized-mismatch');
  assert.equal(grade(obs('2026-11-20T10:00:00.000Z', '2026-11-20T10:00:02.100Z'), ruleset).verdict, 'semantic-mismatch');
  // the case that breaks bucket-based tolerance: a pair straddling a boundary
  assert.equal(grade(obs('2026-11-20T09:59:59.900Z', '2026-11-20T10:00:01.100Z'), ruleset).verdict, 'normalized-mismatch');
});

/* ---------- grading ---------- */

for (const c of cases) {
  test(`grade: ${c.name} -> ${c.expect}`, () => {
    const obs = {
      observationVersion: '1.0',
      id: 'obs_abcdefgh12345678',
      capturedAt: '2026-11-20T10:00:00.000Z',
      meta: { replayMode: 'fixture', importer: 'prototype@0' },
      request: c.request,
      legacy: c.legacy,
      shadow: c.shadow,
    };
    assert.equal(grade(obs, ruleset).verdict, c.expect);
  });
}

test('grading is a pure function of (observation, ruleset)', () => {
  const obs = {
    observationVersion: '1.0',
    id: 'obs_abcdefgh12345678',
    capturedAt: '2026-11-20T10:00:00.000Z',
    meta: { replayMode: 'fixture', importer: 'prototype@0' },
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: { a: 1, b: [1, 2] } },
    shadow: { status: 200, body: { a: 2, b: [1, 2] } },
  };
  const one = JSON.stringify(grade(obs, ruleset));
  const two = JSON.stringify(grade(obs, ruleset));
  assert.equal(one, two);
  assert.match(one, /semantic-mismatch/);
});

/* ---------- observation contract ---------- */

const validObs = () => ({
  observationVersion: '1.0',
  id: 'obs_abcdefgh12345678',
  capturedAt: '2026-11-20T10:00:00.000Z',
  meta: { replayMode: 'fixture', importer: 'har@1.2' },
  request: { method: 'GET', path: '/api/orders', query: { page: ['2'] }, headers: {} },
  legacy: {
    status: 200,
    headers: {},
    body: { orderId: '12345678901234567890', amount: '12.00' },
    writeSet: [{ table: 'orders', pk: { id: '12345678901234567890' }, op: 'update', patch: { status: { before: 'new', after: 'paid' } } }],
  },
  shadow: { status: 200, headers: {}, body: null },
});

test('contract accepts a well-formed observation', () => {
  const r = validateObservation(validObs());
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('contract rejects a 64-bit id sent as a JSON number', () => {
  const obs = validObs();
  obs.legacy.body.orderId = 12345678901234567890;
  const r = validateObservation(obs);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /must be a string/);
});

test('contract rejects money without fixed scale', () => {
  const obs = validObs();
  obs.legacy.body.amount = '12.5';
  assert.equal(validateObservation(obs).ok, false);
});

test('contract rejects an insert without fullRow', () => {
  const obs = validObs();
  obs.legacy.writeSet = [{ table: 'orders', pk: { id: '1' }, op: 'insert' }];
  assert.equal(validateObservation(obs).ok, false);
});

test('contract rejects an out-of-range status', () => {
  const obs = validObs();
  obs.shadow.status = 999;
  assert.equal(validateObservation(obs).ok, false);
});