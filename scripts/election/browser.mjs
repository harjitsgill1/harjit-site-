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
  browser = await chromium.launch();
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
    const r = await fetch(p, { cache: 'no-store' });
    return { status: r.status, body: await r.text() };
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

export async function closeBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null; ctx = null; pages.clear();
}
