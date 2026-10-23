// Results adapters. Each takes a race's `source` object and returns
// { candidates: [{name, party, votes, pct}], reporting, reportedAt, sourceUrl }
// or null when the source has no data for that race yet.

import { execFileSync } from 'node:child_process';
import { browserFetch, browserFetchBinary, pageText, pageHtml } from './browser.mjs';

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

// "JEFFREY PRANG" -> "Jeffrey Prang" (leaves mixed-case names alone)
const titleCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s);

// Visible text lines from raw HTML (keeps collapsed sections).
const htmlLines = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"')
  .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

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
      // Before Ohio switches the feed to the general election it still shows the
      // party primaries; a general-election contest has more than one party.
      if (!src.allowPrimary && new Set(cands.map((x) => x.party)).size < 2) continue;
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
        seats: num(c.VF) || 1,
        candidates: c.CH.map((n, k) => ({ name: titleCase(n), party: c.P?.[k] || null, votes: num(c.V?.[k]), pct: num(c.PCT?.[k]) })),
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

  // "Enhanced Voting" county results platform (Sacramento and others).
  // src: { base: "https://results.saccounty.gov/results/public/api/elections/sacramento-county-ca",
  //        ids: [69, 70], date: "2026-11-03", match?: phrase in the contest name }
  async enhanced(src, race) {
    let data = null;
    // Prefer discovery: the jurisdiction listing names each election with its date.
    if (src.jurisdiction) {
      const root = src.base.replace(/\/elections\/[^/]+\/?$/, '');
      const j = await once('evj:' + src.base, () => getJson(`${root}/jurisdictions/${src.jurisdiction}`).catch(() => null));
      const el = (j?.elections || []).find((e) => String(e.electionDate).startsWith(src.date || '2026-11-03'));
      if (!el) return null; // November election not listed yet
      data = await once(`ev:${src.base}/${el.publicElectionId}`, () => getJson(`${src.base}/${el.publicElectionId}/data`).catch(() => null));
      if (!data) return null;
    }
    for (const id of data ? [] : (src.ids || [src.id])) {
      const j = await once(`ev:${src.base}/${id}`, () => getJson(`${src.base}/${id}/data`).catch(() => null));
      if (j && String(j.election?.electionDate || j.election?.date || '').startsWith(src.date || '2026-11-03')) { data = j; break; }
      if (j && !src.date) { data = j; break; }
    }
    if (!data) return null;
    const t = (arr) => (arr || []).map((x) => x.text).find(Boolean) || '';
    const want = String(src.match || '').toUpperCase();
    for (const item of data.ballotItems || []) {
      const name = t(item.name);
      if (want && !name.toUpperCase().includes(want)) continue;
      const opts = item.summaryResults?.ballotOptions || [];
      if (!opts.some((o) => sameName(race.candidate, t(o.name)))) continue;
      const total = opts.reduce((a, o) => a + (o.voteCount || 0), 0);
      const rs = item.reportingStatus || {};
      return {
        contest: name,
        seats: num(String(t(item.voteFor)).replace(/\D+/g, '')) || 1,
        candidates: opts.filter((o) => !o.isWriteIn || o.voteCount).map((o) => ({ name: titleCase(t(o.name)), party: o.party?.abbreviation || null, votes: o.voteCount, pct: total ? o.voteCount / total * 100 : 0 })),
        reporting: rs.totalUnits ? `${rs.reportingUnits} of ${rs.totalUnits} precincts reporting` : null,
        reportedAt: rs.asOf ? new Date(rs.asOf).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : null,
        sourceUrl: src.base.replace('/api/elections/', '/'),
      };
    }
    return null;
  },

  // Los Angeles County Registrar results JSON. src: { ids: [4339, ...], date, match? }
  async lavote(src, race) {
    let e = null;
    for (const id of src.ids) {
      const j = await once(`la:${id}`, () => getJson(`https://results.lavote.gov/electionresults/json?electionid=${id}`).catch(() => null));
      if (j?.Election && String(j.Election.Date).startsWith(src.date || '2026-11-03')) { e = j.Election; break; }
    }
    if (!e) return null;
    const want = String(src.match || '').toUpperCase();
    for (const g of e.ContestGroups || []) for (const c of g.Contests || []) {
      if (want && !(`${g.Name} ${c.Title}`).toUpperCase().includes(want)) continue;
      const cands = c.Candidates || [];
      if (!cands.some((x) => sameName(race.candidate, x.Name))) continue;
      const total = cands.reduce((a, x) => a + (x.Votes || 0), 0);
      return {
        contest: c.Title,
        candidates: cands.map((x) => ({ name: titleCase(x.Name), party: x.Party && x.Party !== 'Non Partisan' ? x.Party : null, votes: x.Votes, pct: total ? x.Votes / total * 100 : 0 })),
        reporting: null, reportedAt: null,
        sourceUrl: 'https://results.lavote.gov/',
      };
    }
    return null;
  },

  // Alameda County results pages (alamedacountyca.gov/rovresults/<id>/), server-
  // rendered. src: { ids: [..], title: "November 3, 2026", match?: phrase in contest }
  async alameda(src, race) {
    let lines = null, url = null;
    for (const id of src.ids) {
      const u = `https://alamedacountyca.gov/rovresults/${id}/`;
      const ls = await once('ala:' + u, async () => htmlLines(await pageHtml(u, 6000).catch(() => '')));
      if (ls.some((l) => l.includes(src.title || 'November 3, 2026'))) { lines = ls; url = u; break; }
    }
    if (!lines) return null;
    const want = String(src.match || '').toUpperCase();
    for (let i = 0; i < lines.length; i++) {
      const rep = lines[i + 1] || '';
      if (!/Precincts (?:Partially |Fully )?Reported/i.test(rep)) continue;
      const contest = lines[i];
      if (want && !contest.toUpperCase().includes(want)) continue;
      const seats = num((lines[i + 2] || '').match(/\((\d+)\)/)?.[1]) || 1;
      const cands = [];
      for (let k = i + 2; k + 2 < lines.length && !/Precincts (?:Partially |Fully )?Reported/i.test(lines[k + 1] || ''); k++) {
        if (/^[\d,]+$/.test(lines[k + 1]) && /^[\d.]+\s*%$/.test(lines[k + 2])) {
          cands.push({ name: lines[k], party: null, votes: num(lines[k + 1]), pct: num(lines[k + 2]) }); k += 2;
        }
      }
      if (cands.some((c) => sameName(race.candidate, c.name))) {
        return { contest, seats, candidates: cands, reporting: rep.replace(/\s+/g, ' '), reportedAt: null, sourceUrl: url,
          note: /RCV/.test(contest) ? 'First-choice votes; ranked-choice rounds are published separately' : undefined };
      }
    }
    return null;
  },

  // Orange County (Hart "livevoterturnout" ENR). The current election's page is
  // linked from ocvote.gov. src: { match?: phrase in contest }
  async oc_hart(src, race) {
    const page = await once('oc:url', async () => {
      const html = await getText('https://ocvote.gov/results/current-election-results');
      return html.match(/https:\/\/www\.livevoterturnout\.com\/ENR\/orangecaenr\/\d+\/en\/[^"']*Index_\d+\.html/)?.[0] || null;
    });
    if (!page) return null;
    const text = await once('ocp:' + page, () => pageText(page, 10000));
    if (!/November 3, 2026|2026 (Statewide )?General/i.test(text)) return null; // still showing an older election
    const lines = text.split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const want = String(src.match || '').toUpperCase();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^Contest:\s*(.*?)(?:,\s*VOTE FOR (\d+))?$/i);
      if (!m) continue;
      if (want && !m[1].toUpperCase().includes(want)) continue;
      const cands = [];
      for (let k = i + 1; k < lines.length && !/^Contest:/i.test(lines[k]); k++) {
        const v = lines[k].match(/^([\d,]+) ([\d.]+)%$/);
        if (v) {
          const raw = lines[k - 1];
          const pm = raw.match(/^(.*?)\s*\(([A-Z]+)\)$/);
          cands.push({ name: titleCase(pm ? pm[1] : raw), party: pm ? pm[2] : null, votes: num(v[1]), pct: num(v[2]) });
        }
      }
      if (cands.some((c) => sameName(race.candidate, c.name))) {
        return { contest: m[1], seats: num(m[2]) || 1, candidates: cands, reporting: null, reportedAt: null, sourceUrl: page };
      }
    }
    return null;
  },

  // Fresno County posts election-night "Election Summary Report" PDFs on its
  // results page (behind bot protection). src: { month: 11, year: 26, match? }
  async fresno(src, race) {
    const PAGE = 'https://www.fresnocountyca.gov/Departments/County-ClerkRegistrar-of-Voters/Elections/Election-Results';
    const lines = await once('fresno', async () => {
      const html = await pageHtml(PAGE, 8000);
      const links = [...html.matchAll(/href="([^"]*electionsummaryreportrpt[^"]*\.pdf)"/gi)].map((m) => m[1])
        .filter((h) => { const d = h.match(/(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})/); return d && Number(d[1]) === (src.month || 11) && String(d[3]).endsWith(String(src.year || 26)); });
      if (!links.length) return null; // November report not posted yet
      const path = links[0].replace(/^https?:\/\/[^/]+/, '');
      const pdf = await browserFetchBinary(PAGE, path);
      const text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf, maxBuffer: 64 << 20 }).toString();
      return text.split(/\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    });
    if (!lines) return null;
    const want = String(src.match || '').toUpperCase();
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^(.*)\(Vote for (\d+)\)$/i);
      if (!h || !/^Precincts Reported/i.test(lines[i + 1] || '')) continue;
      if (want && !h[1].toUpperCase().includes(want)) continue;
      const cands = [];
      for (let k = i + 2; k < lines.length && !/\(Vote for \d+\)$/i.test(lines[k]); k++) {
        if (/^(Times Cast|Undervotes|Overvotes|Candidate|Total)\b/i.test(lines[k])) continue;
        let m = lines[k].match(/^(.*?)\s+([\d,]+)\s+([\d.]+)%$/);
        if (m && m[1]) cands.push({ name: titleCase(m[1].replace(/\s+(DEM|REP|NPP|LIB|GRN|PF|AI)$/, '')), party: null, votes: num(m[2]), pct: num(m[3]) });
        else if ((m = lines[k].match(/^([\d,]+)\s+([\d.]+)%$/)) && lines[k - 1]) cands.push({ name: titleCase(lines[k - 1]), party: null, votes: num(m[1]), pct: num(m[2]) });
      }
      if (cands.some((c) => sameName(race.candidate, c.name))) {
        return { contest: h[1].trim(), seats: num(h[2]) || 1, candidates: cands.filter((c) => !/write-in/i.test(c.name)),
          reporting: lines[i + 1].replace(/^Precincts Reported:\s*/i, '') + ' precincts reporting', reportedAt: null, sourceUrl: PAGE };
      }
    }
    return null;
  },

  // New York State Board of Elections, no-JavaScript results page (all contests
  // on one page). src: { match: "7th Congressional District" | "Governor" | ... }
  async ny_enr(src, race) {
    const text = await once('ny', () => pageText('https://nyenr.elections.ny.gov/HomeNoJS.aspx', 6000));
    const lines = text.split(/\n/);
    const want = String(src.match || '').toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^\s*(.*?) > All Counties\s+Election Districts Reporting:\s*([\d,]+) of ([\d,]+)/);
      if (!h) continue;
      if (want && !h[1].toLowerCase().startsWith(want)) continue;
      const cands = [];
      for (let k = i + 1; k < lines.length && !/> All Counties/.test(lines[k]); k++) {
        const cells = lines[k].split('\t').map((c) => c.trim());
        if (cells.length < 8 || !cells[0] || /^(Candidate|Blank|Void|Write-in|Total Votes)$/i.test(cells[0])) continue;
        const votes = num(cells[cells.length - 1]);
        if (votes == null || !cells[1]) continue; // party-line rows (WOR, CON) have no candidate total
        cands.push({ name: cells[0], party: cells[1], votes, pct: num(cells[cells.length - 2]) });
      }
      if (cands.some((c) => sameName(race.candidate, c.name))) {
        return { contest: h[1], candidates: cands, reporting: `${h[2]} of ${h[3]} election districts reporting`, reportedAt: null, sourceUrl: 'https://nyenr.elections.ny.gov/' };
      }
    }
    return null;
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
