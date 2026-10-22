import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';

const TARGET = process.env.WEPLAY_URL || 'https://weplayapp.com/en-IN/recharge';
const RESULT_TIMEOUT_MS = Number(process.env.RESULT_TIMEOUT_MS || 15000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 20000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300000);
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 10000);
const MAX_CONCURRENT = Math.max(1, Math.min(10, Number(process.env.BROWSER_CONCURRENCY || 5)));
const MAX_BODY_BYTES = 16 * 1024;
const VALID_UID = /^\d{5,}$/;

// Vercel may reuse a warm function instance. Reuse its browser and cache when possible.
let browserPromise;
const cache = new Map();
const inflight = new Map();
let active = 0;
const waiters = [];

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    }).catch((err) => {
      browserPromise = undefined;
      throw err;
    });
  }
  return browserPromise;
}

function cached(uid) {
  const item = cache.get(uid);
  if (!item) return undefined;
  if (item.expiresAt <= Date.now()) {
    cache.delete(uid);
    return undefined;
  }
  cache.delete(uid);
  cache.set(uid, item);
  return item.data;
}
function cacheSet(uid, data) {
  cache.delete(uid);
  cache.set(uid, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

async function acquireSlot() {
  if (active < MAX_CONCURRENT) { active++; return; }
  if (waiters.length >= 20) {
    const err = new Error('Server busy. Try again shortly');
    err.code = 'QUEUE_FULL';
    throw err;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active++;
}
function releaseSlot() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

async function scrape(uid) {
  await acquireSlot();
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(Math.min(12000, RESULT_TIMEOUT_MS));
    await page.route('**/*', async (route) => {
      const req = route.request();
      let hostname = '';
      try { hostname = new URL(req.url()).hostname; } catch {}
      if (['image', 'font', 'media'].includes(req.resourceType()) ||
          /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|sentry|segment\.io|mixpanel|clarity\.ms|newrelic|bugsnag|cloudflareinsights/i.test(hostname)) {
        return route.abort();
      }
      return route.continue();
    });
    const response = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    if (response && response.status() >= 400) throw new Error(`WePlay page returned HTTP ${response.status()}`);
    const input = page.locator('input.input, input[placeholder*="WePlay ID" i], input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: Math.min(12000, RESULT_TIMEOUT_MS) });
    await input.fill(uid);
    const submit = page.locator('.submit:visible').first();
    if (await submit.count()) await submit.click();
    else await input.press('Enter');

    const result = await page.waitForFunction(() => {
      const nickname = document.querySelector('.nickname')?.textContent?.trim() || '';
      const raw = document.querySelector('.value')?.textContent?.trim() || '';
      if (!nickname || !raw) return false;
      const match = raw.match(/Charm\s*:\s*([\d,]+)/i);
      const charm = match ? match[1].replace(/,/g, '') : raw.replace(/^Charm\s*:\s*/i, '').trim();
      let avatar = document.querySelector('img.avatar')?.currentSrc || document.querySelector('img.avatar')?.src || null;
      if (!avatar) {
        const candidate = [...document.images].find((image) => {
          try { return /^picuser[^/]*\.weplayapp\.com$/i.test(new URL(image.currentSrc || image.src).hostname); }
          catch { return false; }
        });
        avatar = candidate?.currentSrc || candidate?.src || null;
      }
      return { nickname, charm, profile_pic_url: avatar };
    }, null, { timeout: RESULT_TIMEOUT_MS });
    const data = await result.jsonValue();
    await result.dispose();
    return data;
  } finally {
    if (context) await context.close().catch(() => {});
    releaseSlot();
  }
}

async function lookup(uid) {
  const hit = cached(uid);
  if (hit !== undefined) return { data: hit, cached: true };
  if (inflight.has(uid)) return { data: await inflight.get(uid), cached: false };
  const pending = scrape(uid).then((data) => {
    cacheSet(uid, data);
    return data;
  }).finally(() => {
    if (inflight.get(uid) === pending) inflight.delete(uid);
  });
  inflight.set(uid, pending);
  return { data: await pending, cached: false };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

export default async function handler(req, res) {
  const started = Date.now();
  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      status: 'ok',
      pool: { alive_in_pool: browserPromise ? 1 : 0, target_size: MAX_CONCURRENT, started: Boolean(browserPromise) },
      cache_size: cache.size,
      uptime_s: 0,
    });
  }
  if (url.pathname !== '/lookup' || !['GET', 'POST'].includes(req.method || 'GET')) {
    return send(res, 404, { success: false, error: 'Not found' });
  }

  let rawUid;
  if (req.method === 'GET') rawUid = url.searchParams.get('uid') ?? '';
  else {
    try { rawUid = (await readBody(req)).uid ?? ''; }
    catch (err) {
      if (err.code === 'BODY_TOO_LARGE') return send(res, 413, { success: false, error: 'Request body too large' });
      throw err;
    }
  }
  const uid = String(rawUid).trim();
  if (!VALID_UID.test(uid)) return send(res, 400, { success: false, error: 'Invalid UID' });

  try {
    const result = await lookup(uid);
    return send(res, 200, {
      success: true,
      uid,
      nickname: result.data.nickname,
      charm: result.data.charm ?? '',
      profile_pic_url: result.data.profile_pic_url ?? null,
      cached: Boolean(result.cached),
      took_ms: Date.now() - started,
    });
  } catch (err) {
    if (err.code === 'QUEUE_FULL') return send(res, 503, { success: false, error: err.message }, { 'retry-after': '2' });
    if (err.code === 'LOOKUP_TIMEOUT' || err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) {
      return send(res, 504, { success: false, error: 'Timeout fetching UID' });
    }
    console.error('UID lookup failed:', err);
    return send(res, 500, { success: false, error: 'Failed to fetch UID', details: err?.message || String(err) });
  }
}
