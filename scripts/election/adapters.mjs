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

export const adapters = {
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
