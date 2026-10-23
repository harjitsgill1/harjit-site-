// Shared headless browser for results sites behind bot-protection challenges
// (Cloudflare, AWS WAF). One page per site is opened and kept for the run;
// data URLs are then fetched from inside that page so the cleared session's
// cookies apply. Playwright is installed by the workflow, not committed.

let browser = null;
let ctx = null;
const pages = new Map();

async function launch() {
  if (ctx) return ctx;
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('browser not available (playwright not installed)'); }
  // GitHub's runners ship with Google Chrome; using it skips a 3-minute install.
  try { browser = await chromium.launch({ channel: 'chrome' }); }
  catch { browser = await chromium.launch(); }
  ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    locale: 'en-US',
  });
  return ctx;
}

// Open (once per run) a page on the site and wait for any challenge to clear.
export function sitePage(entryUrl, waitMs = 8000) {
  const key = new URL(entryUrl).origin + '|' + entryUrl;
  if (!pages.has(key)) {
    pages.set(key, (async () => {
      const c = await launch();
      const page = await c.newPage();
      page.setDefaultTimeout(45000);
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(waitMs);
      return page;
    })());
  }
  return pages.get(key);
}

// Fetch a same-origin URL from inside the site's cleared page.
export async function browserFetch(entryUrl, path) {
  if (globalThis.__browserMock) return globalThis.__browserMock.fetch(entryUrl, path); // tests
  const page = await sitePage(entryUrl);
  const out = await page.evaluate(async (p) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(p, { cache: 'no-store', signal: ctrl.signal });
      return { status: r.status, body: await r.text() };
    } catch (e) { return { status: 'error: ' + e.message, body: '' }; }
    finally { clearTimeout(t); }
  }, path);
  if (out.status !== 200) throw new Error(`HTTP ${out.status} ${path}`);
  return out.body;
}

// Visible text of a page (for results published as HTML tables).
export async function pageText(url, waitMs = 10000) {
  if (globalThis.__browserMock) return globalThis.__browserMock.text(url); // tests
  const page = await sitePage(url, waitMs);
  return page.evaluate(() => document.body ? document.body.innerText : '');
}

// Full HTML of a page (includes collapsed/hidden sections that innerText skips).
export async function pageHtml(url, waitMs = 10000) {
  if (globalThis.__browserMock) return globalThis.__browserMock.html(url); // tests
  const page = await sitePage(url, waitMs);
  return page.content();
}

// Download a same-origin binary file through the site's cleared page; returns a Buffer.
export async function browserFetchBinary(entryUrl, path) {
  if (globalThis.__browserMock) return globalThis.__browserMock.binary(entryUrl, path); // tests
  const page = await sitePage(entryUrl);
  const b64 = await page.evaluate(async (p) => {
    const r = await fetch(p, { cache: 'no-store' });
    if (!r.ok) return 'ERR' + r.status;
    const b = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }, path);
  if (b64.startsWith('ERR')) throw new Error('HTTP ' + b64.slice(3) + ' ' + path);
  return Buffer.from(b64, 'base64');
}

export async function closeBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null; ctx = null; pages.clear();
}
