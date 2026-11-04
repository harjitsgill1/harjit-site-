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
const FL_PAGES = { USS: 'https://floridaelectionwatch.gov/FederalOffices/USSenator' };
export const parseFlPage = (html) => {
  const rows = new Map();
  for (const m of html.matchAll(/<td class="pt-2 grid-cell">\s*([^<]+?)\s*<\/td>[\s\S]*?<span>\s*([\d,]+)\s*<\/span>/g)) {
    rows.set(m[1].replace(/\s+/g, ' '), Number(m[2].replace(/,/g, '')));
  }
  return rows;
};

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
    if (!eid && src.byDate) {
      // Clarity's elections.json lists {EID, ElectionName, Date:"11/3/2026 12:00:00 AM"}.
      const list = JSON.parse(await once('cl:list:' + src.path, () => browserFetch(`${src.site}/${src.path}/`, `/${src.path}/elections.json`)));
      eid = list.find((e) => String(e.Date).startsWith(src.byDate) && !/recount/i.test(e.ElectionName))?.EID;
      if (!eid) return null; // November election not posted yet
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
    let total = list.reduce((s, c) => s + c.votes, 0);
    // On election night 2026 the flat file stayed at zero while the state's own
    // results page had the counts, so read that page when the file is empty.
    const page = FL_PAGES[src.race];
    if (!total && page) {
      const rows = parseFlPage(await getText(page, 25000));
      for (const c of list) { const v = rows.get(c.name.replace(/\s+/g, ' ')); if (v) c.votes = v; }
      total = list.reduce((s, c) => s + c.votes, 0);
      if (total) {
        list.forEach((c) => { c.pct = c.votes / total * 100; });
        return { candidates: list, reporting: null, reportedAt: null, sourceUrl: page };
      }
    }
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
    // County-level races live in county sub-elections under the same election id
    // (e.g. .../elections/king-county-wa/20261103). `counties` lists slugs to try.
    if (src.counties && !src._county) {
      const top = await adapters.enhanced({ ...src, counties: null }, race);
      if (top) return top;
      const root = src.base.replace(/\/elections\/[^/]+\/?$/, '');
      const j = await once('evj:' + src.base, () => getJson(`${root}/jurisdictions/${src.jurisdiction}`).catch(() => null));
      const el = (j?.elections || []).find((e) => String(e.electionDate).startsWith(src.date || '2026-11-03'));
      if (!el) return null;
      for (const c of src.counties) {
        const r = await adapters.enhanced({ ...src, _county: true, jurisdiction: null, counties: null,
          base: `${root}/elections/${c}`, ids: [el.publicElectionId] }, race);
        if (r) return r;
      }
      return null;
    }
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
        candidates: opts.filter((o) => !o.isWriteIn || o.voteCount).map((o) => ({ name: titleCase(t(o.name).replace(/\s*\((I|Dem|Rep|Lib|Grn|Ind|NP|NPP)\)/gi, '').trim()), party: o.party?.abbreviation || (t(o.name).match(/\((Dem|Rep|Lib|Grn|Ind)\)/i) || [])[1] || null, votes: o.voteCount, pct: total ? o.voteCount / total * 100 : 0 })),
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
          cands.push({ name: titleCase((pm ? pm[1] : raw).replace(/^\*+\s*/, '')), party: pm ? pm[2] : null, votes: num(v[1]), pct: num(v[2]) });
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
    // The county now gives each election its own sub-page; the reports may be there rather than on the main page.
    const SUB = PAGE + '/2026/RESULTS-FOR-NOVEMBER-3-2026-CONSOLIDATED-STATEWIDE-GENERAL-ELECTION';
    const lines = await once('fresno', async () => {
      const summary = /href="([^"]*election[-_ ]?summary[^"]*\.pdf[^"]*)"/gi;
      const subHtml = await pageHtml(SUB, 8000).catch((e) => { console.log(`fresno: sub-page failed: ${e.message}`); return ''; });
      // Everything on the November sub-page is this election's, so no date filter there.
      let entry = SUB;
      let links = [...subHtml.matchAll(summary)].map((m) => m[1]);
      if (!links.length) {
        entry = PAGE;
        const html = await pageHtml(PAGE, 8000);
        links = [...html.matchAll(summary)].map((m) => m[1])
          .filter((h) => { const d = h.match(/(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})/); return d && Number(d[1]) === (src.month || 11) && String(d[3]).endsWith(String(src.year || 26)); });
      }
      if (!links.length) {
        const pdfs = [...subHtml.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)].map((m) => m[1]).slice(0, 10);
        console.log(`fresno: no summary report found; sub-page ${subHtml.length} chars, PDF links: ${pdfs.join(' ') || 'none'}`);
        return null; // November report not posted yet
      }
      // Each count gets its own file, e.g. ...-11.3.26-8.00.pdf; read the newest whatever the page order.
      // Times have no AM/PM: after 12.xx on the same date, small hours are past midnight.
      const rank = (h) => {
        const m = h.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})-(\d{1,2})\.(\d{2})\.pdf/i);
        if (!m) return -1;
        const hour = Number(m[4]) >= 8 ? Number(m[4]) : Number(m[4]) + 12;
        return Number(m[1]) * 1e6 + Number(m[2]) * 1e4 + hour * 100 + Number(m[5]);
      };
      links = [...links].sort((x, y) => rank(y) - rank(x));
      console.log(`fresno: using ${links[0]}`);
      const path = links[0].replace(/^https?:\/\/[^/]+/, '');
      const pdf = await browserFetchBinary(entry, path);
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

  // Minnesota Secretary of State results files (semicolon-delimited):
  // state;county;precinct;officeId;office;district;candId;name;suffix;incumbent;party;
  // precinctsReporting;precinctsTotal;votes;pct;totalVotes.
  // src: { files: ["stsenate", "cntyRaceQuestions", ...], match?: phrase in office }
  async mn_sos(src, race) {
    const want = String(src.match || '').toUpperCase();
    for (const f of src.files) {
      const url = `https://electionresultsfiles.sos.mn.gov/${src.date || ELECTION.ymd}/${f}.txt`;
      const rows = (await once('mn:' + url, () => getText(url).catch(() => ''))).split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));
      const groups = new Map();
      for (const r of rows) {
        if (r.length < 16) continue;
        if (want && !r[4].toUpperCase().includes(want)) continue;
        const key = [r[1], r[3], r[4], r[5]].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      for (const rs of groups.values()) {
        if (!rs.some((r) => sameName(race.candidate, r[7]))) continue;
        const seats = num((rs[0][4].match(/Elect (\d+)/i) || [])[1]) || 1;
        return {
          contest: rs[0][4], seats,
          candidates: rs.filter((r) => !/write-in/i.test(r[7])).map((r) => ({ name: r[7], party: r[10] || null, votes: num(r[13]), pct: num(r[14]) })),
          reporting: `${num(rs[0][11])} of ${num(rs[0][12])} precincts reporting`, reportedAt: null,
          sourceUrl: 'https://electionresults.sos.mn.gov/',
        };
      }
    }
    return null;
  },

  // Texas Secretary of State (Civix ENR). One file per election with base64-encoded
  // sections for federal, statewide and district (legislative/judicial) races.
  // src: { id: 53815, match?: phrase in race name }
  async tx_civix(src, race) {
    const j = await once('tx:' + src.id, () => getJson(`https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/${src.id}`));
    const dec = (k) => { try { return JSON.parse(Buffer.from(j[k] || '', 'base64').toString('utf8')); } catch { return null; } };
    const home = dec('Home') || {};
    const want = String(src.match || '').toUpperCase();
    for (const sec of ['Federal', 'StateWide', 'Districted']) {
      for (const r of dec(sec)?.Races || []) {
        if (want && !String(r.N).toUpperCase().includes(want)) continue;
        const cands = (r.Candidates || []).map((c) => ({ name: titleCase(String(c.N).replace(/\s*\(I\)\s*$/, '')), party: c.P || null, votes: num(c.V), pct: num(c.PE) }));
        if (!cands.some((c) => sameName(race.candidate, c.name))) continue;
        const pr = home.PrecinctsReporting || {};
        return { contest: titleCase(r.N), candidates: cands,
          reporting: home.CountiesReporting ? `${home.CountiesReporting.CR} of ${home.CountiesReporting.CT} counties reporting` : null,
          reportedAt: home.LastUpdatedTime || null, sourceUrl: 'https://goelect.txelections.civixapps.com/ivis-enr-ui/races' };
      }
    }
    return null;
  },

  // New Mexico Secretary of State results pages (server-rendered). type: FED | SW | LGX.
  // Each contest: heading, "FOLLOW THIS CONTEST", "PRECINCTS FULLY: a / b", then
  // name / party / pct% / votes groups, then "TOTAL VOTES". src: { type, match: exact heading }
  // Connecticut's Election Center publishes plain JSON for the whole state.
  // src: { match: "<office name as listed>" }
  async ct_ems(src, race) {
    const base = 'https://ctemspublic.tgstg.net/ng-app/data/election';
    const data = await once('ct:data', async () => {
      const elections = await getJson('https://ctemspublic.tgstg.net/ng-app/data/Elections.json');
      const id = (elections.find((e) => e.DefaultElection === 'Y') || {}).ID;
      const { Version: v } = await getJson(`${base}/${id}/Version.json`);
      const [lookup, votes, summary] = await Promise.all(['Lookupdata', 'stateVotes_Electiondata', 'election_Electiondata']
        .map((f) => getJson(`${base}/${id}/${v}/${f}.json`)));
      return { lookup, votes, summary };
    });
    if (!/11\/03\/2026/.test(data.lookup.election?.DT || '')) return null;
    const want = String(src.match || '').toLowerCase();
    const office = data.lookup.officeList.map((o) => Object.values(o)[0]).find((o) => o.NM.toLowerCase() === want);
    if (!office) return null;
    // Connecticut allows fusion voting: one person can hold several party lines,
    // each listed separately, so add those lines together per candidate.
    const byName = new Map();
    for (const row of data.votes[office.ID] || []) {
      const [cid, val] = Object.entries(row)[0];
      const c = data.lookup.candidateIds[cid] || {};
      const party = data.lookup.partyIds[c.P]?.CD || null;
      const name = c.NM || cid;
      const cur = byName.get(name) || { name, parties: [], votes: 0 };
      if (party) cur.parties.push(party);
      cur.votes += num(val.V) || 0;
      byName.set(name, cur);
    }
    const total = [...byName.values()].reduce((a, c) => a + c.votes, 0);
    const cands = [...byName.values()].map((c) => ({ name: c.name, party: c.parties.join('/') || null, votes: c.votes, pct: total ? c.votes / total * 100 : 0 }));
    if (!cands.some((c) => c.name.split(/ and /i).some((n) => sameName(race.candidate, n)))) return null;
    return { contest: office.NM, candidates: cands, reporting: data.summary.PR ? `${data.summary.PR} polling places reporting` : null, reportedAt: null, sourceUrl: 'https://ctemspublic.tgstg.net/#/home' };
  },

  async nm_sos(src, race) {
    const url = `https://electionresults.sos.nm.gov/resultsSW.aspx?type=${src.page}&map=CTY`;
    const text = await once("nm:" + src.page, () => pageText(url, 6000, { scroll: true }));
    if (!/GENERAL 2026/.test(text)) return null; // still showing another election
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const want = String(src.match || '').toUpperCase();
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] !== 'FOLLOW THIS CONTEST') continue;
      const contest = lines[i - 1];
      if (want && contest.toUpperCase() !== want) continue;
      const pf = (lines[i + 1] || '').match(/FULLY:\s*([\d,]+)\s*\/\s*([\d,]+)/);
      const cands = [];
      for (let k = i + 2; k + 3 < lines.length && lines[k] !== 'TOTAL VOTES'; k++) {
        if (/^[\d.]+%$/.test(lines[k + 2]) && /^[\d,]+$/.test(lines[k + 3])) {
          cands.push({ name: titleCase(lines[k]), party: lines[k + 1], votes: num(lines[k + 3]), pct: num(lines[k + 2]) }); k += 3;
        }
      }
      if (cands.some((c) => sameName(race.candidate, c.name.split(/ and /i)[0]) || sameName(race.candidate, c.name))) {
        return { contest: titleCase(contest), candidates: cands, reporting: pf ? `${pf[1]} of ${pf[2]} precincts fully reported` : null, reportedAt: null, sourceUrl: url };
      }
    }
    return null;
  },

  // DC Board of Elections (Cloudflare). Election list gives a UrlText per election;
  // getCityWide returns every contest with candidates, votes and winners.
  async dc_boe(src, race) {
    const ENTRY = 'https://electionresults.dcboe.org/';
    const list = JSON.parse(await once('dc:list', () => browserFetch(ENTRY, '/electionResults/getElectionResultsId')));
    const el = list.find((e) => String(e.ElectionDate).startsWith(src.date || '2026-11-03'));
    if (!el) return null; // November election not posted yet
    const contests = JSON.parse(await once('dc:cw:' + el.UrlText, () => browserFetch(ENTRY, `/cityWide/getCityWide/${el.UrlText}`)));
    const want = String(src.match || '').toUpperCase();
    for (const c of contests) {
      if (want && !String(c.OfficeName).toUpperCase().includes(want)) continue;
      const rows = (c.ElectionData || []).filter((x) => !/^write-?in$/i.test(x.Contestant));
      if (!rows.some((x) => sameName(race.candidate, x.Contestant))) continue;
      const winner = rows.find((x) => x.IsWinner);
      return { contest: titleCase(c.OfficeName), candidates: rows.map((x) => ({ name: x.Contestant, party: x.PartyCode || null, votes: num(x.Votes), pct: num(x.VotesPercentage) })),
        reporting: null, reportedAt: null, called: winner ? winner.Contestant : undefined, calledBy: winner ? 'DCBOE' : undefined,
        sourceUrl: `${ENTRY}election_results/${el.UrlText}` };
    }
    return null;
  },

  // Delaware Department of Elections results page (one HTML page per election).
  // Each contest: heading, [party], "Candidate Name" + 5 column headers, then rows of
  // name, machine, absentee, early, total, pct. src: { file: "GE2026", match: heading }
  async de_doe(src, race) {
    const url = `https://elections.delaware.gov/results/enr/${src.file || 'GE2026'}.html`;
    const html = await once('de:' + url, () => pageHtml(url, 6000).catch(() => null));
    if (!html) return null; // November page not posted yet
    const lines = htmlLines(html);
    const want = String(src.match || '').toUpperCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== 'Candidate Name') continue;
      let h = i - 1;
      while (h > 0 && !/(District|Senator|Congress|General|Treasurer|Council|Executive|Sheriff|Recorder|Mayor|Auditor|Comptroller|Commissioner|Register|Clerk|President|Levy)/i.test(lines[h]) || (lines[h] || '').length > 90) h--;
      const contest = lines[h];
      if (want && !contest.toUpperCase().includes(want)) continue;
      // Column count comes from the header row (Delaware added an Early Voting column).
      const cols = lines.indexOf('Percentage', i) - i + 1;
      if (cols < 3) continue;
      const cands = [];
      for (let k = i + cols; k + cols - 1 < lines.length && !/^-->|^Candidate Name$/.test(lines[k]); k += cols) {
        if (!/^[\d,]+$/.test(lines[k + cols - 2]) || !/^[\d.]+$/.test(lines[k + cols - 1])) break;
        cands.push({ name: titleCase(lines[k]), party: null, votes: num(lines[k + cols - 2]), pct: num(lines[k + cols - 1]) });
      }
      if (cands.some((c) => sameName(race.candidate, c.name))) {
        return { contest, candidates: cands, reporting: null, reportedAt: null, sourceUrl: url };
      }
    }
    return null;
  },

  // California Secretary of State results API. Paths look like "us-rep/district/7".
  // SOE Software "resultsSW.aspx" state results sites (Oregon, Montana).
  // src: { host: "https://results.oregonvotes.gov", page: "FED", map?: "CTY", match?: phrase in contest name }
  async soe(src, race) {
    const url = `${src.host}/resultsSW.aspx?type=${src.page}&map=${src.map || 'CTY'}`;
    const parse = (lines) => {
      const isVal = (l) => /^[\d,]+$/.test(l) || /^[\d.]+\s?%$/.test(l);
      const skip = /^(export:?|share on|\||partially:.*|follow this contest|<img.*|src=.*)$/i;
      const want = String(src.match || '').toUpperCase();
      for (let i = 1; i < lines.length; i++) {
        if (!/^follow this contest$/i.test(lines[i])) continue;
        const contest = lines[i - 1];
        if (want && !contest.toUpperCase().includes(want)) continue;
        let rep = null; const cands = [];
        let k = i + 1;
        for (; k < lines.length && !/^follow this contest$/i.test(lines[k]) && !/^total votes$/i.test(lines[k]); k++) {
          const l = lines[k];
          const m = l.match(/^([\d,]+) out of ([\d,]+) Precincts Reported$/i) || l.match(/^Precincts Fully:\s*([\d,]+)\s*\/\s*([\d,]+)/i);
          if (m) { rep = `${m[1]} of ${m[2]} precincts reported`; continue; }
          if (skip.test(l) || isVal(l)) continue;
          let j = k + 1, party = null;
          if (j < lines.length && !isVal(lines[j]) && !skip.test(lines[j])) { party = lines[j]; j++; }
          const vals = [];
          while (j < lines.length && isVal(lines[j])) vals.push(lines[j++]);
          if (!vals.length) continue;
          const v = vals.find((x) => !x.includes('%')); const pc = vals.find((x) => x.includes('%'));
          if (!/^write-?in/i.test(l)) cands.push({ name: titleCase(l), party, votes: num(v), pct: pc != null ? num(pc) : null });
          k = j - 1;
        }
        if (!cands.some((c) => sameName(race.candidate, c.name))) continue;
        const tot = cands.reduce((a, c) => a + (c.votes || 0), 0);
        for (const c of cands) if (c.pct == null) c.pct = tot ? c.votes / tot * 100 : 0;
        return { contest: titleCase(contest), candidates: cands, reporting: rep, reportedAt: null, sourceUrl: url };
      }
      return null;
    };
    const html = await once('soe:' + url, () => getText(url).catch(() => ''));
    const r = parse(htmlLines(html));
    if (r || !src.scroll) return r;
    // Long pages load more contests as you scroll.
    const text = await once('soeb:' + url, () => pageText(url, 6000, { scroll: true }).catch(() => ''));
    return parse(text.split(/\n/).map((l) => l.trim()).filter(Boolean));
  },

  // Maryland State Board of Elections results pages (plain HTML tables).
  // src: { page: "gen_results_2026_by_county_17.html" }; the candidate's name picks the contest.
  async md_sbe(src, race) {
    const url = `https://elections.maryland.gov/elections/2026/general_results/${src.page}`;
    const lines = htmlLines(await once('md:' + url, () => getText(url)));
    const isVal = (l) => /^(NR|[\d,]+|[\d.]+%)$/.test(l);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== 'Percentage') continue;
      let rep = null;
      for (let b = i; b > i - 12 && b >= 0; b--) { const m = lines[b].match(/\(([\d,]+) of ([\d,]+) election day precincts reported\)/i); if (m) { rep = `${m[1]} of ${m[2]} election day precincts reported`; break; } }
      const cands = [];
      for (let k = i + 1; k + 1 < lines.length && lines[k] !== 'Percentage'; k++) {
        if (isVal(lines[k]) || isVal(lines[k + 1])) continue;
        let j = k + 2; const vals = [];
        while (j < lines.length && isVal(lines[j])) vals.push(lines[j++]);
        if (!vals.length) continue;
        cands.push({ name: lines[k], party: lines[k + 1], votes: vals.length >= 6 ? num(vals[4]) || 0 : 0, pct: vals.length >= 6 ? num(vals[5]) || 0 : 0 });
        k = j - 1;
      }
      if (cands.some((c) => sameName(race.candidate, c.name))) {
        return { contest: race.office, candidates: cands, reporting: rep, reportedAt: null, sourceUrl: url };
      }
    }
    return null;
  },

  // San Francisco Department of Elections summary page. Ranked-choice contests
  // report Round 1 here. src: { match?: phrase in contest name }
  async sf_doe(src, race) {
    const url = 'https://www.sfelections.org/results/20261103/';
    const lines = htmlLines(await once('sf:' + url, () => getText(url)));
    const want = String(src.match || '').toUpperCase();
    const isVal = (l) => /^[\d,]+$/.test(l) || /^[\d.]+%$/.test(l);
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] !== 'Ballots Counted') continue;
      let h = i - 1;
      while (h > 0 && !/^[A-Z][A-Z0-9 ,.'’()-]+$/.test(lines[h].replace(/\s*\(Ranked-Choice Voting Contest\)/, ''))) h--;
      const contest = lines[h].replace(/\s*\(Ranked-Choice Voting Contest\)/, '').trim();
      if (want && !contest.toUpperCase().includes(want)) continue;
      const cands = [];
      for (let k = i + 2; k + 2 < lines.length; k++) {
        if (lines[k] === 'Ballots Counted') break;
        if (/^(write-?in|total)$/i.test(lines[k])) { k += 2; continue; }
        if (!isVal(lines[k]) && /^[\d,]+$/.test(lines[k + 1]) && /%$/.test(lines[k + 2])) {
          cands.push({ name: titleCase(lines[k]), party: null, votes: num(lines[k + 1]), pct: num(lines[k + 2]) }); k += 2;
        } else if (cands.length && !isVal(lines[k])) break;
      }
      if (cands.some((c) => sameName(race.candidate, c.name))) {
        return { contest: titleCase(contest), candidates: cands, reporting: null, reportedAt: null, sourceUrl: url };
      }
    }
    return null;
  },

  // Fox News election feed (AP numbers). Unofficial; used where the state's own
  // site blocks us or posts nothing. src: { office: "House"|"Senate"|"Governor", state: "PA", district?: 17 }
  async fox(src, race) {
    const url = `https://feeds-elections.foxnews.com/archive/politics/elections/2026/3/2026_Generals/${src.office}/${src.state}/state_level_results/file.json`;
    const j = await once('fox:' + url, () => getJson(`${url}?cb=${Math.floor(Date.now() / 60000) * 60000}`));
    const list = Array.isArray(j) ? j : j.races || [];
    for (const r of list) {
      if (src.district != null && Number(r.district?.districtNumber) !== Number(src.district)) continue;
      const res = r.results || [];
      const cands = res.map((x) => ({ name: `${x.candidate?.firstName || ''} ${x.candidate?.lastName || ''}`.trim(), party: x.partyCode || null, votes: num(x.votes?.count) || 0, pct: num(x.votes?.percentage) || 0 }));
      if (!cands.some((c) => sameName(race.candidate, c.name))) continue;
      const tot = r.districtTotals || r.stateTotals || {};
      const w = res.findIndex((x) => x.isWinner);
      const out = { contest: race.office, candidates: cands,
        reporting: tot.expectedPercentage != null ? `${tot.expectedPercentage}% in (AP via Fox News)` : null,
        reportedAt: r.last_updated || j.last_updated || null,
        sourceUrl: `https://www.foxnews.com/elections/2026/midterm-results/state/${src.slug || ''}` };
      if (w >= 0) { out.called = cands[w].name; out.calledBy = 'AP'; }
      return out;
    }
    return null;
  },

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
