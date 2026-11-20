// Corpus runner + acceptance gate.
//   node gate.mjs
// Prints a verdict table and enforces the gate from SPEC.md 3.2:
//   0 false alarms on the noise set, >= 95% recall on the semantic set.

import { grade, validateObservation } from './isomer.mjs';
import { ruleset, cases } from './corpus.mjs';

const rows = cases.map((c) => {
  const obs = {
    observationVersion: '1.0',
    id: 'obs_' + Buffer.from(c.name).toString('hex').slice(0, 16),
    capturedAt: '2026-11-20T10:00:00.000Z',
    meta: { replayMode: 'fixture', importer: 'prototype@0' },
    request: c.request,
    legacy: c.legacy,
    shadow: c.shadow,
  };
  const contract = validateObservation(obs);
  const result = grade(obs, ruleset);
  return {
    name: c.name,
    expect: c.expect,
    got: result.verdict,
    diffs: result.diffs.length,
    contract: contract.ok ? 'ok' : contract.errors[0],
    pass: result.verdict === c.expect,
  };
});

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('case', 44) + pad('expected', 20) + pad('graded', 20) + 'diffs');
console.log('-'.repeat(94));
for (const r of rows) {
  const mark = r.pass ? ' ' : 'X';
  console.log(`${mark}${pad(r.name, 43)}${pad(r.expect, 20)}${pad(r.got, 20)}${r.diffs}`);
}

const noise = rows.filter((r) => r.expect !== 'semantic-mismatch');
const real = rows.filter((r) => r.expect === 'semantic-mismatch');
const falseAlarms = noise.filter((r) => r.got === 'semantic-mismatch').length;
const caught = real.filter((r) => r.got === 'semantic-mismatch').length;
const recall = real.length === 0 ? 1 : caught / real.length;
const contractFailures = rows.filter((r) => r.contract !== 'ok');

console.log('');
console.log(`noise set           ${noise.length} cases   false alarms: ${falseAlarms}`);
console.log(`semantic set        ${real.length} cases   caught: ${caught}   recall: ${(recall * 100).toFixed(1)}%`);
console.log(`contract fixtures   ${rows.length - contractFailures.length}/${rows.length} valid`);

const gate = falseAlarms === 0 && recall >= 0.95 && contractFailures.length === 0;
console.log(gate ? '\nGATE: PASS' : '\nGATE: FAIL');
process.exit(gate ? 0 : 1);