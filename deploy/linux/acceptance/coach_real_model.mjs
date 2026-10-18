/* Real-model acceptance for the AI Coach's four tasks against the restricted gym bridge.
 *
 * Production code paths only: payload.build, runPipeline (prompt → adapter → parse →
 * validate, incl. the single repair round) and the openclaw adapter are the repo's own
 * modules, untouched. The only scaffolding here is a synthetic-but-legal user state and a
 * thin invoke counter so the report can say whether the repair round fired.
 *
 * Never prints or writes the bridge token. Run with OPENCLAW_COACH_TOKEN in the env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results-coach.json');

// handle.js resolves DATA_DIR at import time, so the temp dir (with its secret file) must
// exist before the dynamic import below — exactly how the api tests do it (helpers.tempData).
const { tempData, sampleState } = await import('../../../api/test/helpers.mjs');
tempData();
const { handleFor } = await import('../../../api/coach/handle.js');
const payloadLib = await import('../../../api/coach/core/payload.js');
const { runPipeline } = await import('../../../api/coach/core/pipeline.js');
const adapter = (await import('../../../api/coach/adapters/openclaw.js')).default;

if (!process.env.OPENCLAW_COACH_TOKEN) {
  console.error('OPENCLAW_COACH_TOKEN is not set; aborting without calling anything.');
  process.exit(2);
}

const cfg = {
  providerOptions: {
    openclaw: { baseUrl: 'http://127.0.0.1:18890', profileUid: 'R0e1jddEojjLXL6u' }
  }
};
const env = { OPENCLAW_COACH_TOKEN: process.env.OPENCLAW_COACH_TOKEN };
const MODEL = 'openclaw/gym-coach';
// Production's own job budget (api/coach/jobs.js TIMEOUT_MS default, 5 min). The bridge cuts
// an upstream call at 290s, so with this the bridge's own 504 still reaches the adapter. A
// 240s budget proved tighter than production: a real create ran past it twice.
const TIMEOUT_MS = +process.env.TIMEOUT_MS || 470000;
const MAX_TOKENS = +process.env.MAX_TOKENS || 24000;

/* ---------- synthetic but legal state: recent dumbbell training relative to today ---------- */
const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const stamp = (n, h) => { const d = daysAgo(n); d.setHours(h, 0, 0, 0); return d.getTime(); };

// Catalogue ids (api/coach/core/library-data.js): all dumbbell / body-weight, so they survive
// the equipment-filtered library slice. 0289 bench, 0293 row, 0426 OHP, 1760 goblet squat,
// 1459 RDL, 2135 weighted plank.
const UPPER = { id: 'rA', name: '上肢日', emoji: '💪', prog: 'linear', ex: [
  { id: '0289', sets: 3, reps: 10, mode: 'reps', weight: 20, prog: 'linear', inc: 2.5 },
  { id: '0293', sets: 3, reps: 10, mode: 'reps', weight: 22.5, prog: 'linear', inc: 2.5 },
  { id: '0426', sets: 3, reps: 8, mode: 'reps', weight: 12.5, prog: 'linear', inc: 1 }
] };
const LOWER = { id: 'rB', name: '下肢日', emoji: '🦵', prog: 'linear', ex: [
  { id: '1760', sets: 3, reps: 10, mode: 'reps', weight: 24, prog: 'linear', inc: 2 },
  { id: '1459', sets: 3, reps: 8, mode: 'reps', weight: 30, prog: 'linear', inc: 2.5 },
  { id: '2135', sets: 3, sec: 45, mode: 'time' }
] };

const rep = (w, r, rpe) => ({ w, r, done: true, ...(rpe != null ? { rpe } : {}) });
function upperWorkout(id, ago, benchReps, note) {
  return {
    id, d: iso(daysAgo(ago)), name: UPPER.name, start: stamp(ago, 18), end: stamp(ago, 18) + 55 * 60000, prs: [],
    ...(note ? { note } : {}),
    entries: [
      { id: '0289', target: { sets: 3, reps: 10, weight: 20 }, sets: benchReps.map((r, i) => rep(20, r, i === benchReps.length - 1 ? 9.5 : 8.5)) },
      { id: '0293', target: { sets: 3, reps: 10, weight: 22.5 }, sets: [rep(22.5, 10, 7.5), rep(22.5, 10, 8), rep(22.5, 10, 8.5)] },
      { id: '0426', target: { sets: 3, reps: 8, weight: 12.5 }, sets: [rep(12.5, 8, 8), rep(12.5, 8, 8.5), rep(12.5, 7, 9.5)] }
    ]
  };
}
function lowerWorkout(id, ago, note) {
  return {
    id, d: iso(daysAgo(ago)), name: LOWER.name, start: stamp(ago, 18), end: stamp(ago, 18) + 50 * 60000, prs: [],
    ...(note ? { note } : {}),
    entries: [
      { id: '1760', target: { sets: 3, reps: 10, weight: 24 }, sets: [rep(24, 10, 8), rep(24, 10, 8.5), rep(24, 10, 9)] },
      { id: '1459', target: { sets: 3, reps: 8, weight: 30 }, sets: [rep(30, 8, 8), rep(30, 8, 8.5), rep(30, 8, 9)] },
      { id: '2135', target: { sets: 3, sec: 45 }, sets: [{ sec: 45, done: true }, { sec: 45, done: true }, { sec: 40, done: true }] }
    ]
  };
}

// DAYS=2 shrinks the asked-for plan (and so the model's output) — a probe for whether a
// create fits the bridge's 290s upstream window at all; the scenario stays legal either way.
const DAYS = [2, 3].includes(+process.env.DAYS) ? +process.env.DAYS : 3;
const PROFILE = {
  goal: 'muscle', experience: 'returning', daysPerWeek: DAYS, sessionMin: 60,
  preferredDays: [1, 3, 5].slice(0, DAYS),
  equipment: ['dumbbell', 'body weight'],
  limitations: '轻微下背不适,硬拉类动作保持中等重量',
  likes: '哑铃复合动作',
  dislikes: '长时间有氧',
  notes: '在家训练,只有一对可调哑铃,每只最大 24kg'
};

// Bench stalls over the last three upper sessions → the review has something real to say.
const WORKOUTS = [
  upperWorkout('w1', 26, [10, 10, 10]),
  lowerWorkout('w2', 24),
  upperWorkout('w3', 22, [10, 10, 10]),
  upperWorkout('w4', 19, [10, 10, 9]),
  lowerWorkout('w5', 17),
  upperWorkout('w6', 15, [10, 9, 8]),
  upperWorkout('w7', 12, [10, 8, 7]),
  lowerWorkout('w8', 10),
  upperWorkout('w9', 8, [9, 8, 7], '卧推第三组很吃力,肩膀前侧有点紧'),
  lowerWorkout('w10', 3, '深蹲感觉不错,平板支撑最后一组没撑满')
];
const DEBRIEF_WORKOUT_ID = 'w10';

const S = sampleState({
  lang: 'zh', unit: 'kg', effort: 'rpe', targetW: 72,
  coach: { consent: { agreedAt: new Date().toISOString(), version: 1 }, profile: PROFILE },
  routines: [UPPER, LOWER],
  week: { 1: 'rA', 3: 'rB', 5: 'rA' },
  exWeights: { '0289': { w: 20 }, '0293': { w: 22.5 } },
  bodyweight: [
    { d: iso(daysAgo(25)), w: 70.6 }, { d: iso(daysAgo(14)), w: 70.9 }, { d: iso(daysAgo(2)), w: 71.2 }
  ],
  workouts: WORKOUTS
});
const HANDLE = handleFor('acceptance-user-1');

/* ---------- helpers ---------- */
const CJK = /[㐀-䶿一-鿿]/;
const hasCJK = v => typeof v === 'string' && CJK.test(v);
const firstCJK = texts => {
  const t = texts.find(hasCJK) || '';
  return t.slice(0, 120);
};

function textsOf(label, attempt) {
  if (attempt.nochange) return [attempt.reading];
  const r = attempt.result || {};
  if (label === 'review') {
    return [r.summary, ...(r.notes || []), ...(r.changes || []).map(c => c.why)];
  }
  if (label === 'debrief') {
    return [r.summary, ...(r.highlights || []), ...(r.watch || []), ...(r.nextTime || [])];
  }
  const b = r.bundle || {};
  return [b.summary, b.basedOn, b.name];
}

// Every id the answer names must be one we offered — i.e. not translated, not invented.
function idCheck(label, attempt, payload) {
  if (attempt.nochange) return { ok: true, checked: 0 };
  const offered = new Set((payload.library || []).map(e => e.id));
  const planRoutines = new Set((payload.plan?.routines || []).map(r => r.id));
  const planEx = new Set((payload.plan?.routines || []).flatMap(r => (r.ex || []).map(e => e.id)));
  const bad = [];
  let checked = 0;
  if (label === 'review') {
    for (const c of attempt.result.changes || []) {
      if (c.target?.routineId) { checked++; if (!planRoutines.has(c.target.routineId)) bad.push('routine:' + c.target.routineId); }
      if (c.target?.exId) { checked++; if (!planEx.has(c.target.exId)) bad.push('ex:' + c.target.exId); }
      const after = c.after;
      if (after && typeof after === 'object' && typeof after.id === 'string') {
        checked++; if (!offered.has(after.id)) bad.push('after:' + after.id);
      }
    }
  } else if (label === 'create' || label === 'refine') {
    const b = attempt.result.bundle;
    const customIds = new Set((b.customEx || []).map(e => e.id));
    const routineIds = new Set((b.routines || []).map(r => r.id));
    for (const r of b.routines || []) for (const e of r.ex || []) {
      checked++; if (!offered.has(e.id) && !customIds.has(e.id)) bad.push('ex:' + e.id);
    }
    for (const d of Object.keys(b.week || {})) for (const rid of [].concat(b.week[d])) {
      checked++; if (!routineIds.has(rid)) bad.push('week:' + rid);
    }
  }
  return { ok: bad.length === 0, checked, bad };
}

async function runTask(label, kind, opts) {
  const payload = payloadLib.build(S, { handle: HANDLE, kind, lang: 'zh', ...opts });
  const size = JSON.stringify(payload).length;
  if (size > payloadLib.MAX_PAYLOAD_CHARS) throw new Error(`${label}: payload ${size} chars exceeds MAX_PAYLOAD_CHARS`);
  console.log(`[${label}] payload ${Math.round(size / 1000)}k chars (task=${payload.task}, lang=${payload.meta.lang}, unit=${payload.meta.unit})`);

  // Invocations within ONE runPipeline > 1 means the single repair round fired. The counter
  // resets per run so a transport-level retry of the whole pipeline is not mistaken for it.
  let invocations = 0;
  const counting = { ...adapter, invoke: a => (invocations++, adapter.invoke(a)) };
  const once = () => { invocations = 0; return runPipeline({
    adapter: counting, cfg, kind, payload, model: MODEL, timeoutMs: TIMEOUT_MS,
    invokeOpts: { env, maxTokens: MAX_TOKENS }
  }); };

  const t0 = Date.now();
  let transportRetries = 0;
  let attempt = await once();
  // One transport-level retry (timeout / provider hiccup) — never for a validation failure.
  if (!attempt.ok && ['timeout', 'provider'].includes(attempt.errorClass)) {
    console.log(`[${label}] transport failure (${attempt.errorClass}, ${attempt.detail || ''}); retrying once in 5s`);
    await new Promise(r => setTimeout(r, 5000));
    transportRetries = 1;
    attempt = await once();
  }
  const ms = Date.now() - t0;

  // "Hit the 290s wall": our own 300s deadline fired, or the bridge's 504 upstream_timeout came back.
  const hit290 = (!attempt.ok && attempt.errorClass === 'timeout')
    || /^504 /.test(String(attempt.detail || ''));
  const entry = {
    kind: label, ok: !!attempt.ok, nochange: !!attempt.nochange,
    repairRound: invocations > 1, transportRetries, hitBridgeTimeout: hit290,
    planDays: DAYS, ms
  };
  if (!attempt.ok) {
    entry.cjk = false;
    entry.errorClass = attempt.errorClass;
    // The adapter's error strings are fixed phrases (it never echoes upstream bodies), and the
    // validator's errors describe the synthetic payload — neither can carry the token.
    if (attempt.detail) entry.detail = String(attempt.detail).slice(0, 300);
    if (attempt.errors) entry.errors = attempt.errors.map(e => String(e).slice(0, 300)).slice(0, 8);
    console.log(`[${label}] FAILED errorClass=${attempt.errorClass} detail=${entry.detail || ''} invocations=${invocations} ms=${ms}`);
    return { entry, attempt, payload };
  }

  const texts = textsOf(label, attempt).filter(Boolean);
  entry.cjk = texts.some(hasCJK);
  entry.sample = firstCJK(texts);
  const ids = idCheck(label, attempt, payload);
  entry.idsOk = ids.ok;
  entry.idsChecked = ids.checked;
  if (!ids.ok) entry.badIds = ids.bad;
  console.log(`[${label}] ok nochange=${entry.nochange} repair=${entry.repairRound} ms=${ms} cjk=${entry.cjk} ids=${ids.ok ? 'ok' : 'BAD ' + ids.bad.join(',')} (${ids.checked} checked)`);
  console.log(`[${label}] sample: ${entry.sample}`);
  return { entry, attempt, payload };
}

/* ---------- the four tasks ---------- */
// SKIP=review,debrief reruns only the rest and keeps the skipped kinds' entries from the
// existing results file — so a flaky task can be retried without re-billing the passing ones.
const skip = new Set((process.env.SKIP || '').split(',').map(s => s.trim()).filter(Boolean));
const previousResults = fs.existsSync(RESULTS)
  ? (JSON.parse(fs.readFileSync(RESULTS, 'utf8')).results || []) : [];
const kept = kind => previousResults.find(r => r.kind === kind)
  || { kind, ok: false, nochange: false, repairRound: false, ms: 0, cjk: false, errorClass: 'skipped' };
const results = [];
let createBundle = null;

// 1. create (with intake)
if (skip.has('create')) { results.push(kept('create')); } else {
  const { entry, attempt } = await runTask('create', 'create', { intake: PROFILE });
  results.push(entry);
  if (attempt.ok && !attempt.nochange) createBundle = attempt.result.bundle;
}

// 2. review
if (skip.has('review')) { results.push(kept('review')); } else {
  const { entry } = await runTask('review', 'review', {});
  results.push(entry);
}

// 3. create + refine (previous = first create's bundle)
if (skip.has('refine')) { results.push(kept('refine')); } else if (createBundle) {
  const { entry } = await runTask('refine', 'create', { intake: PROFILE, refine: '把周三改成拉力日', previous: createBundle });
  results.push(entry);
} else {
  results.push({ kind: 'refine', ok: false, nochange: false, repairRound: false, ms: 0, cjk: false, errorClass: 'skipped', errors: ['create produced no bundle to refine'] });
  console.log('[refine] skipped: no bundle from create');
}

// 4. debrief
if (skip.has('debrief')) { results.push(kept('debrief')); } else {
  const { entry } = await runTask('debrief', 'debrief', { workoutId: DEBRIEF_WORKOUT_ID });
  results.push(entry);
}

fs.writeFileSync(RESULTS, JSON.stringify({ ranAt: new Date().toISOString(), model: MODEL, bridge: cfg.providerOptions.openclaw.baseUrl, results }, null, 2));
console.log('wrote ' + RESULTS);
process.exit(results.every(r => r.ok && r.cjk && r.idsOk !== false) ? 0 : 1);
