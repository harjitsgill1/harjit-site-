// Results adapters. Each takes a race's `source` object and returns
// { candidates: [{name, party, votes, pct}], reporting, reportedAt, sourceUrl }
// or null when the source has no data for that race yet.

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

export const adapters = {
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
