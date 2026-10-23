// Election results updater.
//
// Reads election/data/races.json, pulls live numbers for every race with an
// automatic source (adapters.mjs), merges hand-entered numbers from
// election/data/manual.json, and writes:
//   election/data/results.json    the real results (feeds only after polls close)
//   election/data/rehearsal.json  before polls close: the same pipeline run on the
//                                 test data election offices post, for ?rehearsal
//
// Every run stamps checkedAt (a heartbeat) so the page can warn when updates stop.
// Writes GITHUB_OUTPUT changed=true when any race's numbers changed, so the
// workflow commits only real changes but republishes the site every run.
//
// Env:  FORCE=1   live file accepts feed data before polls close (testing only)

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { adapters } from './adapters.mjs';
import { closeBrowser } from './browser.mjs';

const DATA = new URL('../../election/data/', import.meta.url);
const file = (name) => new URL(name, DATA);

// Earliest polls close: 6 PM Eastern on Nov 3 2026 = 22:00 UTC.
const FIRST_POLLS_CLOSE = Date.parse('2026-11-03T22:00:00Z');
const FORCE = process.env.FORCE === '1';
const pollsClosed = Date.now() >= FIRST_POLLS_CLOSE;

const readJson = async (url, fallback) => {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch { return fallback; }
};

async function runAll(tasks, limit = 6) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < tasks.length) { const k = i++; await tasks[k](); }
  }));
}

const races = (await readJson(file('races.json'), { races: [] })).races;
const manual = await readJson(file('manual.json'), {});
// Race calls (AP or official), kept separate so live feed numbers keep flowing:
// { "<race id>": { "winner": "<full name>", "by": "AP", "at": "<ISO time>" } }
const calls = await readJson(file('calls.json'), {});

// Fetch each distinct source once per run, shared by both outputs.
const cache = new Map();
// Hard limit per source so one slow or stuck site can never freeze the run.
const SOURCE_TIMEOUT_MS = 75000;
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s (${label})`)), ms).unref()),
]);
const timing = {};
const fetchOnce = (src, race) => {
  const key = JSON.stringify(src) + '|' + race.candidate;
  if (!cache.has(key)) {
    const t0 = Date.now();
    cache.set(key, withTimeout(adapters[src.type](src, race), SOURCE_TIMEOUT_MS, src.type)
      .finally(() => { timing[src.type] = Math.max(timing[src.type] || 0, Date.now() - t0); }));
  }
  return cache.get(key);
};

async function build(outName, useFeeds, useManual) {
  const prev = await readJson(file(outName), { results: {} });
  const next = {};
  const log = { ok: 0, failed: [], skipped: 0 };

  await runAll(races.map((race) => async () => {
    const src = race.source || {};
    const old = prev.results?.[race.id];
    let entry = null;
    if (useFeeds && adapters[src.type]) {
      try {
        const r = await fetchOnce(src, race);
        if (r) { entry = { ...r, origin: 'feed' }; log.ok++; }
        else log.skipped++;
      } catch (e) {
        log.failed.push(`${race.id}: ${e.message}`);
        if (old) entry = { ...old, stale: true };
      }
    } else {
      log.skipped++;
    }
    // Hand-entered numbers always win; delete the entry to hand back to the feed.
    if (useManual && manual[race.id]) entry = { ...manual[race.id], origin: 'manual' };
    if (useManual && entry && calls[race.id]?.winner && !entry.called) entry = { ...entry, called: calls[race.id].winner, calledBy: calls[race.id].by || null };
    if (entry) next[race.id] = entry;
  }));

  const now = new Date().toISOString();
  const strip = (e) => { if (!e) return e; const { changedAt, stale, ...rest } = e; return rest; };
  let changed = false;
  for (const [id, e] of Object.entries(next)) {
    const old = prev.results?.[id];
    if (JSON.stringify(strip(e)) !== JSON.stringify(strip(old))) { e.changedAt = now; changed = true; }
    else e.changedAt = old?.changedAt || now;
    if (old?.stale !== e.stale) changed = true;
  }
  if (Object.keys(prev.results || {}).some((id) => !(id in next))) changed = true;

  const updatedAt = changed ? now : (prev.updatedAt || null);
  await writeFile(file(outName),
    JSON.stringify({ updatedAt, checkedAt: now, feeds: { ok: log.ok, failed: log.failed.length }, results: next }, null, 1) + '\n');

  console.log(`${outName}: feeds ok ${log.ok}, skipped ${log.skipped}, failed ${log.failed.length}, ${changed ? 'CHANGED' : 'no change'}`);
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=${outName}::ok ${log.ok}, skipped ${log.skipped}, failed ${log.failed.length}, changed ${changed}`);
    log.failed.slice(0, 40).forEach((f) => console.log(`::warning title=Feed failed (${outName})::${f}`));
  }
  return changed;
}

let changed = await build('results.json', pollsClosed || FORCE, true);
if (!pollsClosed) changed = (await build('rehearsal.json', true, false)) || changed;

if (process.env.REPORT === '1') {
  // One-line-per-race report of every automatic source, as a single annotation.
  const rows = [];
  for (const race of races) {
    const src = race.source || {};
    if (!adapters[src.type]) continue;
    let line;
    try {
      const r = await fetchOnce(src, race);
      line = r ? `OK    ${src.type.padEnd(8)} ${race.candidate} :: ${r.contest || ''} :: ${(r.candidates || []).slice(0, 3).map((c) => `${c.name} ${c.votes ?? ''}`).join(' | ')}`
               : `EMPTY ${src.type.padEnd(8)} ${race.candidate} (source has no data for this race yet)`;
    } catch (e) { line = `FAIL  ${src.type.padEnd(8)} ${race.candidate} :: ${e.message}`; }
    rows.push(line);
  }
  rows.sort();
  console.log(rows.join('\n'));
  await writeFile(new URL('../../feeds-report.txt', import.meta.url), rows.join('\n') + '\n');
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Per-race report::${rows.join('%0A')}`);
}
await withTimeout(closeBrowser(), 15000, 'closing browser').catch(() => {});
const slow = Object.entries(timing).map(([k, v]) => `${k} ${Math.round(v / 1000)}s`).join(', ');
console.log('slowest call per source type: ' + slow);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Timing::${slow}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
process.exit(0); // don't let a hung browser keep the job alive
