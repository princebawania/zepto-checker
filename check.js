#!/usr/bin/env node
// Zepto price check - GitHub Actions cloud runner.
// Env: ZEPTO_STATE (browser storage state JSON), GIST_TOKEN, GIST_ID, NTFY_TOPIC (optional)
const fs = require('fs');

const GIST_ID = process.env.GIST_ID;
const TOKEN = process.env.GIST_TOKEN;
const NTFY = process.env.NTFY_TOPIC || '';
const items = JSON.parse(fs.readFileSync('items.json', 'utf8')).items.filter(i => i.url && i.name);

function istHour() {
  return parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }), 10);
}
function pvidOf(url) { const m = url.match(/pvid\/([0-9a-f-]+)/i); return m ? m[1] : null; }
function paise(v) { return v >= 1000 ? v / 100 : v; }

function scanBodiesForPrice(bodies, pvid) {
  let best = null;
  const tiers = {};
  const rankMap = { discountedSellingPrice: 0, superSaverSellingPrice: 1, sellingPrice: 2, discountedPrice: 3 };
  for (const body of bodies) {
    if (!body || !body.includes(pvid)) continue;
    const pvPos = [];
    let i = body.indexOf(pvid);
    while (i !== -1) { pvPos.push(i); i = body.indexOf(pvid, i + 1); }
    const tierRe = /\\?"bundleItemQuantity\\?"\s*:\s*(\d+)/g;
    let tm;
    while ((tm = tierRe.exec(body))) {
      const w = body.slice(tm.index, tm.index + 700);
      if (!w.includes(pvid)) continue;
      const pm = w.match(/\\?"sellingPrice\\?"\s*:\s*(\d+(?:\.\d+)?)/);
      const qm = w.match(/\\?"quantity\\?"\s*:\s*(\d+)/);
      const qty = qm ? parseInt(qm[1], 10) : parseInt(tm[1], 10);
      if (pm && qty > 0) tiers[qty] = parseFloat(pm[1]);
    }
    const spRe = /\\?"storeProduct\\?"\s*:\s*\{/g;
    let sm;
    while ((sm = spRe.exec(body))) {
      let dist = Infinity;
      for (const p of pvPos) { const d = Math.abs(sm.index - p); if (d < dist) dist = d; }
      if (dist > 6000) continue;
      const w = body.slice(sm.index, sm.index + 900);
      const pm = w.match(/\\?"discountedSellingPrice\\?"\s*:\s*(\d+(?:\.\d+)?)/);
      if (!pm) continue;
      const mm = body.slice(Math.max(0, sm.index - 1500), sm.index + 900).match(/\\?"mrp\\?"\s*:\s*(\d+(?:\.\d+)?)/);
      const om = w.match(/\\?"outOfStock\\?"\s*:\s*(true|false)/);
      if (!best || best.rank !== -1 || dist < best.dist) {
        best = { dist, rank: -1, price: parseFloat(pm[1]), mrp: mm ? parseFloat(mm[1]) : null,
                 outOfStock: om ? om[1] === 'true' : null, key: 'storeProduct' };
      }
    }
    if (!best) {
      const priceRe = /\\?"(discountedSellingPrice|superSaverSellingPrice|sellingPrice|discountedPrice)\\?"\s*:\s*(\d+(?:\.\d+)?)/g;
      let m;
      while ((m = priceRe.exec(body))) {
        let dist = Infinity;
        for (const p of pvPos) { const d = Math.abs(m.index - p); if (d < dist) dist = d; }
        if (dist > 12000) continue;
        const rank = rankMap[m[1]];
        if (!best || dist < best.dist || (dist === best.dist && rank < best.rank)) {
          const w = body.slice(Math.max(0, m.index - 1500), m.index + 1500);
          const mm = w.match(/\\?"mrp\\?"\s*:\s*(\d+(?:\.\d+)?)/);
          const om = w.match(/\\?"outOfStock\\?"\s*:\s*(true|false)/);
          best = { dist, rank, price: parseFloat(m[2]), mrp: mm ? parseFloat(mm[1]) : null,
                   outOfStock: om ? om[1] === 'true' : null, key: m[1] };
        }
      }
    }
  }
  if (best) best.tiers = Object.keys(tiers).map(q => ({ qty: +q, each: tiers[q] })).sort((a, b) => a.qty - b.qty);
  return best;
}

async function gh(url, opts) {
  const res = await fetch(url, Object.assign({
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }
  }, opts));
  if (!res.ok) throw new Error('GitHub ' + res.status + ' for ' + url);
  return res.json();
}

async function ntfy(title, msg, high) {
  if (!NTFY) return;
  try {
    await fetch('https://ntfy.sh/' + NTFY, { method: 'POST', body: msg,
      headers: high ? { 'Title': title, 'Priority': 'high', 'Tags': 'fire,shopping_cart' }
                    : { 'Title': title, 'Tags': 'chart_with_downwards_trend' } });
  } catch (e) { console.log('ntfy failed:', e.message); }
}

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: JSON.parse(process.env.ZEPTO_STATE),
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN', timezoneId: 'Asia/Kolkata',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  const bodies = [];
  page.on('response', async res => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!/json|x-component|text\/plain/.test(ct)) return;
      if (!/zepto/i.test(res.url())) return;
      const t = await res.text();
      if (t && t.length < 5000000) bodies.push(t);
    } catch (e) {}
  });

  const results = [];
  for (const item of items) {
    bodies.length = 0;
    const pvid = pvidOf(item.url);
    const rec = { name: item.name, price: null, mrp: null, inStock: true, tiers: [], alertBelow: item.alertBelow || null };
    try {
      let ok = false, err = null;
      for (let a = 0; a < 3 && !ok; a++) {
        try { await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); ok = true; }
        catch (e) { err = e; await page.waitForTimeout(4000); }
      }
      if (!ok) throw err;
      await page.waitForTimeout(7000);
      bodies.push(await page.content());
      const hit = pvid ? scanBodiesForPrice(bodies, pvid) : null;
      if (hit) {
        rec.price = paise(hit.price);
        rec.mrp = hit.mrp != null ? paise(hit.mrp) : null;
        if (hit.outOfStock != null) rec.inStock = !hit.outOfStock;
        rec.tiers = (hit.tiers || []).map(t => ({ qty: t.qty, each: paise(t.each) }));
      }
      if (rec.price == null) {
        const title = await page.title().catch(() => '?');
        const txt = await page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 400)).catch(() => '?');
        const html = await page.content().catch(() => '');
        console.log('DIAG title:', title);
        console.log('DIAG body snippet:', JSON.stringify(txt));
        console.log('DIAG bodies captured:', bodies.length, '| pvid in HTML:', html.includes(pvid), '| html bytes:', html.length);
      }
    } catch (e) { console.log('ERROR', item.name, e.message); }
    console.log(item.name, '->', rec.price != null ? 'Rs ' + rec.price : 'FAILED',
      rec.tiers.length ? '| tiers: ' + rec.tiers.map(t => t.qty + '@' + t.each).join(',') : '');
    results.push(rec);
  }
  await browser.close();
  if (results.every(r => r.price == null)) { console.log('All items failed - not updating gist.'); process.exit(1); }

  // merge into gist history
  const gist = await gh('https://api.github.com/gists/' + GIST_ID);
  let history = {};
  try { history = JSON.parse(gist.files['history.json'].content); } catch (e) {}
  const now = new Date().toISOString();
  const prevOf = {};
  for (const r of results) {
    if (r.price == null) continue;
    const arr = history[r.name] = history[r.name] || [];
    prevOf[r.name] = arr.length ? arr[arr.length - 1] : null;
    arr.push({ t: now, p: r.price, d: r.tiers.map(t => t.qty + '@' + t.each).join(';'), s: r.inStock });
    if (arr.length > 800) history[r.name] = arr.slice(-800);
  }

  const payload = {
    updated: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }),
    updatedIso: now,
    items: results.map(r => {
      const deal = r.price != null && r.alertBelow && r.price <= r.alertBelow;
      const tierDeal = r.tiers.find(t => r.alertBelow && t.each <= r.alertBelow);
      return { name: r.name, price: r.price, inStock: r.inStock,
        tiers: r.tiers.map(t => t.qty + '@' + t.each).join(';'),
        line: r.price == null ? '--' : (r.inStock === false ? 'OOS' : '₹' + r.price + (r.tiers.length ? ' (' + r.tiers.map(t => t.qty + '@' + t.each).join(',') + ')' : '')),
        color: r.inStock === false ? '#888888' : (deal || tierDeal) ? '#38c172' : '#ffffff',
        deal: !!(deal || tierDeal) };
    })
  };
  await gh('https://api.github.com/gists/' + GIST_ID, { method: 'PATCH', body: JSON.stringify({ files: {
    'zepto.json': { content: JSON.stringify(payload, null, 1) },
    'history.json': { content: JSON.stringify(history) }
  } }) });
  console.log('Gist updated at', payload.updated);

  // notifications: price changes + deal transitions (no repeat-spam)
  for (const r of results) {
    if (r.price == null) continue;
    const prev = prevOf[r.name];
    if (prev && prev.p !== r.price) {
      const dir = r.price < prev.p ? 'DROPPED' : 'rose';
      await ntfy(r.name.replace(/ \(.*/, '') + ' ' + dir + ': Rs ' + prev.p + ' -> Rs ' + r.price,
        r.tiers.length ? 'Tiers: ' + r.tiers.map(t => t.qty + '@' + t.each).join(', ') : 'no tier offers', r.price < prev.p);
    }
    const dealNow = r.inStock !== false && r.alertBelow && (r.price <= r.alertBelow || r.tiers.some(t => t.each <= r.alertBelow));
    const prevTiers = prev && prev.d ? prev.d.split(';').map(s => parseFloat(s.split('@')[1])) : [];
    const dealBefore = prev && prev.s !== false && r.alertBelow && (prev.p <= r.alertBelow || prevTiers.some(p => p <= r.alertBelow));
    if (dealNow && !dealBefore) {
      const best = Math.min(r.price, ...r.tiers.map(t => t.each));
      await ntfy('BUY NOW - Zepto deal', r.name + ' available at Rs ' + best + ' (<= Rs ' + r.alertBelow + ')', true);
    }
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
