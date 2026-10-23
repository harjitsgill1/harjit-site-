// Results adapters. Each takes a race's `source` object and returns
// { candidates: [{name, party, votes, pct}], reporting, reportedAt, sourceUrl }
// or null when the source has no data for that race yet.

import { browserFetch, pageText } from './browser.mjs';

export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const UA = 'Mozilla/5.0 (harjitsgill.com election tracker)';

export async function getText(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(t);
  }
}
export const getJson = async (url) => JSON.parse(await getText(url));

// Download each whole-state file once per run, however many races read it.
const fileCache = new Map();
export const cachedText = (url) => {
  if (!fileCache.has(url)) fileCache.set(url, getText(url, 60000));
  return fileCache.get(url);
};

// Candidate-name matching shared by adapters: same last name and the same
// first three letters of the first name ("Flo Cofer" ~ "Flojaune Cofer").
export const nameParts = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, ' ').replace(/[^a-z ]/g, ' ')
  .split(/\s+/).filter((w) => w && !/^(jr|sr|ii|iii|iv|dr|rev)$/.test(w));
export function sameName(a, b) {
  const x = nameParts(a), y = nameParts(b);
  if (!x.length || !y.length) return false;
  // allow "Last, First" style by checking both orders of the other name
  const lastX = x[x.length - 1];
  const yHasLast = y.includes(lastX);
  if (!yHasLast) return false;
  return y.some((w) => w !== lastX && w.slice(0, 3) === x[0].slice(0, 3));
}

// The general-election date in each state's file naming.
export const ELECTION = { ymd: '20261103', mdY: '11/03/2026' };

// "EL-SAYED, ABDUL" -> "Abdul El-Sayed"
const miName = (s) => {
  const t = (w) => w.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const [last, first] = s.split(/,\s*/);
  return first ? `${t(first)} ${t(last)}` : t(s);
};

// Memoize per run, keyed by string.
const memo = new Map();
const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };

export const adapters = {
  // Michigan Secretary of State results page (browser; Cloudflare).
  // `match` is a phrase in the contest heading, e.g. "UNITED STATES SENATOR"
  // or "12TH DISTRICT REPRESENTATIVE IN CONGRESS".
  async mi_sos(src, race) {
    const url = `https://mvic.sos.state.mi.us/votehistory/Index?type=C&electionDate=${src.date || '11-3-2026'}`;
    const text = await once('mi:' + url, () => pageText(url, 12000));
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const want = String(src.match || '').toUpperCase();
    // Split into contests at heading lines like "... (1) POSITION".
    const contests = [];
    let cur = null;
    for (const l of lines) {
      if (/\(\d+\) POSITIONS?$/.test(l)) { cur = { name: l, rows: [] }; contests.push(cur); continue; }
      if (cur) cur.rows.push(l);
    }
    for (const c of contests) {
      if (want && !c.name.toUpperCase().includes(want)) continue;
      const cands = [];
      const r = c.rows;
      for (let i = 0; i + 2 < r.length; i++) {
        // NAME, votes, pct% (party label usually precedes the name)
        if (/^[\d,]+$/.test(r[i + 1]) && /^[\d.]+%$/.test(r[i + 2]) && !/VOTES:?$/.test(r[i])) {
          cands.push({ name: miName(r[i]), party: /^[A-Z ]+$/.test(r[i - 1] || '') && !r[i - 1].includes(',') ? r[i - 1] : null, votes: num(r[i + 1]), pct: num(r[i + 2]) });
          i += 2;
        }
      }
      if (cands.some((x) => sameName(race.candidate, x.name))) {
        return { contest: c.name, candidates: cands, reporting: null, reportedAt: null, sourceUrl: url };
      }
    }
    return null;
  },

  // Ohio Secretary of State (browser; Cloudflare). The marquee feed carries
  // statewide contests as "Contest : Name (P) - 1,234 (56.78%) ... Name (P) - ...".
  async oh_sos(src, race) {
    const body = await once('oh:marquee', () => browserFetch('https://liveresults.ohiosos.gov/', '/Api/v1/Contest/getMarquee'));
    const want = String(src.match || '').toLowerCase();
    for (const { message } of JSON.parse(body)) {
      const i = message.indexOf(' : ');
      if (i < 0) continue;
      const contest = message.slice(0, i);
      if (want && contest.toLowerCase() !== want) continue;
      const cands = message.slice(i + 3).split(' ... ').map((part) => {
        const m = part.match(/^(.*?)\s*\(([A-Z]+)\)\s*-\s*([\d,]+)\s*\(([\d.]+)%\)/);
        return m && { name: m[1].replace(/\s+/g, ' ').trim(), party: m[2], votes: num(m[3]), pct: num(m[4]) };
      }).filter(Boolean);
      if (cands.some((x) => sameName(race.candidate, x.name.split(' and ')[0]))) {
        return { contest, candidates: cands, reporting: null, reportedAt: null, sourceUrl: 'https://liveresults.ohiosos.gov/' };
      }
    }
    return null;
  },

  // Clarity election-night sites (South Carolina, Georgia, many counties).
  // src: { site: "https://www.enr-scvotes.org", path: "SC", eid?: 126294,
  //        discover?: {url, text} to find the election id on a listing page,
  //        match?: phrase in the contest name }
  async clarity(src, race) {
    let eid = src.eid;
    if (!eid && src.discover) {
      const html = await once('disc:' + src.discover.url, () => getText(src.discover.url));
      const re = new RegExp(`/${src.path}/(\\d+)/[^"']*["'][^>]*>[^<]*${src.discover.text}`, 'i');
      const m = html.match(re);
      if (!m) return null; // election not posted yet
      eid = m[1];
    }
    const entry = `${src.site}/${src.path}/${eid}/`;
    const ver = (await once('cv:' + entry, () => browserFetch(entry, `/${src.path}/${eid}/current_ver.txt`))).trim();
    const sum = JSON.parse(await once(`sum:${entry}${ver}`, () => browserFetch(entry, `/${src.path}/${eid}/${ver}/json/sum.json`)));
    const want = String(src.match || '').toUpperCase();
    for (const c of sum.Contests || []) {
      if (want && !String(c.C).toUpperCase().includes(want)) continue;
      if (!(c.CH || []).some((n) => sameName(race.candidate, n))) continue;
      return {
        contest: c.C,
        candidates: c.CH.map((n, k) => ({ name: n, party: c.P?.[k] || null, votes: num(c.V?.[k]), pct: num(c.PCT?.[k]) })),
        reporting: `${num(c.PR)} of ${num(c.TP)} precincts reporting`,
        reportedAt: null,
        sourceUrl: entry,
      };
    }
    return null;
  },

  // North Carolina State Board of Elections election-night files.
  // file 0 = statewide/legislative/judicial contests; file N = county N
  // (counties numbered alphabetically: Alamance 1, Durham 32, Mecklenburg 60).
  // `match` is a phrase the contest name must contain; the contest is the one
  // that also lists our candidate.
  async nc_sbe(src, race) {
    const url = `https://er.ncsbe.gov/enr/${src.date || ELECTION.ymd}/data/results_${src.file ?? 0}.txt`;
    const rows = JSON.parse(await cachedText(url));
    const want = String(src.match || '').toUpperCase();
    const byContest = new Map();
    for (const r of rows) {
      if (want && !r.cnm.toUpperCase().includes(want)) continue;
      if (!byContest.has(r.cnm)) byContest.set(r.cnm, []);
      byContest.get(r.cnm).push(r);
    }
    const hit = [...byContest.values()].find((rs) => rs.some((r) => sameName(race.candidate, r.bnm)));
    if (!hit) return null;
    const total = hit.reduce((s, r) => s + num(r.vct), 0);
    return {
      contest: hit[0].cnm,
      candidates: hit.map((r) => ({ name: r.bnm, party: r.pty || null, votes: num(r.vct), pct: total ? num(r.vct) / total * 100 : 0 })),
      reporting: `${num(hit[0].prt)} of ${num(hit[0].ptl)} precincts reporting`,
      reportedAt: null,
      sourceUrl: 'https://er.ncsbe.gov/',
    };
  },

  // Florida Division of Elections election-night file (tab-delimited, one row
  // per candidate per county). `race` is the RaceCode (USS = U.S. Senate,
  // USR = U.S. House, STS/STR = state Senate/House); `district` is Juris1num.
  async fl_dos(src) {
    const url = `https://flelectionfiles.floridados.gov/enightfilespublic/${src.date || ELECTION.ymd}_ElecResultsFL.txt`;
    const lines = (await cachedText(url)).split(/\r?\n/);
    const head = lines.shift().split('\t');
    const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
    const cands = new Map();
    const counties = new Map();
    for (const line of lines) {
      if (!line.trim()) continue;
      const f = line.split('\t');
      if (f[col.RaceCode].trim() !== src.race) continue;
      if (src.district && String(Number(f[col.Juris1num])) !== String(Number(src.district))) continue;
      if (src.party && f[col.PartyCode].trim() !== src.party) continue; // primaries only
      const name = [f[col.CanNameFirst], f[col.CanNameMiddle], f[col.CanNameLast]].map((s) => (s || '').trim()).filter(Boolean).join(' ');
      const c = cands.get(name) || { name, party: f[col.PartyCode].trim() || null, votes: 0 };
      c.votes += num(f[col.CanVotes]) || 0;
      cands.set(name, c);
      counties.set(f[col.CountyCode], [num(f[col.PrecinctsReporting]) || 0, num(f[col.Precincts]) || 0]);
    }
    if (!cands.size) return null;
    const list = [...cands.values()];
    const total = list.reduce((s, c) => s + c.votes, 0);
    list.forEach((c) => { c.pct = total ? c.votes / total * 100 : 0; });
    let rep = 0, all = 0;
    for (const [r, a] of counties.values()) { rep += r; all += a; }
    return {
      candidates: list,
      reporting: `${rep.toLocaleString()} of ${all.toLocaleString()} precincts reporting`,
      reportedAt: null,
      sourceUrl: 'https://floridaelectionwatch.gov/',
    };
  },

  // California Secretary of State results API. Paths look like "us-rep/district/7".
  async ca_sos(src) {
    const j = await getJson(`https://api.sos.ca.gov/returns/${src.path}`);
    const list = j.candidates || j.Candidates || [];
    return {
      candidates: list.map((c) => ({ name: c.Name, party: c.Party || null, votes: num(c.Votes), pct: num(c.Percent) })),
      reporting: j.Reporting || null,
      reportedAt: j.ReportingTime || null,
      sourceUrl: 'https://electionresults.sos.ca.gov/',
    };
  },
};
