// Election results updater.
// Reads election/data/races.json, pulls live numbers for every race with an
// automatic source, merges hand-entered numbers from election/data/manual.json,
// and writes election/data/results.json only when something actually changed.
//
// Run locally:  node scripts/election/update.mjs
// Env:  FORCE=1   accept feed data before polls close (for testing only)

import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../../election/data/', import.meta.url);
const RACES = new URL('races.json', ROOT);
const MANUAL = new URL('manual.json', ROOT);
const RESULTS = new URL('results.json', ROOT);

// Election offices post test data before election night. Ignore feed numbers
// until the earliest polls close (6 PM Eastern, Nov 3 2026 = 22:00 UTC).
const FIRST_POLLS_CLOSE = Date.parse('2026-11-03T22:00:00Z');
const FORCE = process.env.FORCE === '1';
const acceptFeeds = FORCE || Date.now() >= FIRST_POLLS_CLOSE;

const readJson = async (url, fallback) => {
  try { return JSON.parse(await readFile(url, 'utf8')); }
  catch { return fallback; }
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'harjitsgill.com election tracker', accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Adapters: each takes a race's `source` object and returns
// { candidates: [{name, party, votes, pct}], reporting, reportedAt, sourceUrl }
// ---------------------------------------------------------------------------
const adapters = {
  // California Secretary of State results API (statewide, congressional,
  // legislative). Paths look like "us-rep/district/7".
  async ca_sos(src) {
    const url = `https://api.sos.ca.gov/returns/${src.path}`;
    const j = await getJson(url);
    const list = j.candidates || j.Candidates || [];
    return {
      candidates: list.map((c) => ({
        name: c.Name, party: c.Party || null,
        votes: num(c.Votes), pct: num(c.Percent),
      })),
      reporting: j.Reporting || null,
      reportedAt: j.ReportingTime || null,
      sourceUrl: 'https://electionresults.sos.ca.gov/',
    };
  },
};

// Simple concurrency limiter, with identical source URLs fetched once.
async function runAll(tasks, limit = 6) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

const races = (await readJson(RACES, { races: [] })).races;
const manual = await readJson(MANUAL, {});
const prev = await readJson(RESULTS, { updatedAt: null, results: {} });

const cache = new Map();
const fetchOnce = (type, src) => {
  const key = type + ':' + JSON.stringify(src);
  if (!cache.has(key)) cache.set(key, adapters[type](src));
  return cache.get(key);
};

const next = {};
const log = { ok: 0, failed: [], skipped: 0 };

await runAll(races.map((race) => async () => {
  const type = race.source?.type;
  const old = prev.results[race.id];
  let entry = null;

  if (acceptFeeds && adapters[type]) {
    try {
      const r = await fetchOnce(type, race.source);
      entry = { ...r, origin: 'feed' };
      log.ok++;
    } catch (e) {
      log.failed.push(`${race.id}: ${e.message}`);
      if (old) entry = { ...old, stale: true };
    }
  } else {
    log.skipped++;
  }

  // Hand-entered numbers always win. Delete the manual entry to hand the
  // race back to its feed.
  const m = manual[race.id];
  if (m) entry = { ...m, origin: 'manual' };
  if (entry) next[race.id] = entry;
}));

// Stamp a change time per race only when its numbers changed.
const now = new Date().toISOString();
const strip = (e) => { if (!e) return e; const { changedAt, stale, ...rest } = e; return rest; };
let changed = false;
for (const [id, e] of Object.entries(next)) {
  const old = prev.results[id];
  if (JSON.stringify(strip(e)) !== JSON.stringify(strip(old))) {
    e.changedAt = now; changed = true;
  } else {
    e.changedAt = old?.changedAt || now;
  }
}
if (Object.keys(prev.results).some((id) => !(id in next))) changed = true;

console.log(`feeds ok: ${log.ok}, skipped (pre-election or manual): ${log.skipped}, failed: ${log.failed.length}`);
log.failed.forEach((f) => console.log('  ' + f));
if (process.env.GITHUB_ACTIONS) {
  // Surface the outcome as run annotations so it is visible without opening logs.
  console.log(`::notice title=Feeds::ok ${log.ok}, skipped ${log.skipped}, failed ${log.failed.length}`);
  log.failed.slice(0, 40).forEach((f) => console.log(`::warning title=Feed failed::${f}`));
  if (FORCE) {
    for (const [id, e] of Object.entries(next).slice(0, 10)) {
      const top = (e.candidates || []).slice(0, 3).map((c) => `${c.name} ${c.votes ?? ''}`).join(' | ');
      console.log(`::notice title=${id}::${e.reporting || ''} :: ${top}`);
    }
  }
}

if (changed) {
  await writeFile(RESULTS, JSON.stringify({ updatedAt: now, results: next }, null, 1) + '\n');
  console.log('results.json updated');
} else {
  console.log('no changes');
}
