/**
 * dtray-shot.mjs — screenshot the Dtray UI in light + dark and probe its state.
 * Adapted from the headless-chrome-cdp skill's cdp-shot.mjs.
 *
 *   node tools/dtray-shot.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = process.argv[2] || 'http://127.0.0.1:3000/';
const PORT = Number(process.env.PORT || 9334);
const W = 1440, H = 900;
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000);
const CHROME = process.env.CHROME ||
  path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');

if (!fs.existsSync(CHROME)) { console.error('chrome not found:', CHROME); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dtray-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeErr = '';
chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error('devtools never came up\n' + chromeErr.slice(-2000));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    this.errors = []; this.failed = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (!m.method) return;
      this.events.push(m);
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        if (m.params.type === 'error') this.errors.push(text);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push(d.exception?.description || d.text);
      } else if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        if (e.level === 'error') this.errors.push(`[${e.source}] ${e.text}`);
      } else if (m.method === 'Network.loadingFailed') {
        this.failed.push(m.params.errorText);
      } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
        this.failed.push(`${m.params.response.status} ${m.params.response.url}`);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  }
  async shot(file) {
    const s = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new CDP(ws)));
    ws.addEventListener('error', () => reject(new Error('websocket failed')));
  });
}

async function waitForPageTarget() {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(250);
  }
  throw new Error('no page target appeared');
}

const OUTDIR = path.join(process.cwd(), 'shots');
fs.mkdirSync(OUTDIR, { recursive: true });

const main = async () => {
  await waitForDevtools();
  const page = await waitForPageTarget();
  const cdp = await connect(page.webSocketDebuggerUrl);

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  console.log('navigating to', URL_);
  await cdp.send('Page.navigate', { url: URL_ });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !cdp.events.some((e) => e.method === 'Page.loadEventFired')) {
    await sleep(250);
  }
  await sleep(SETTLE_MS);

  // ---- probe DOM state ----
  const probe = await cdp.eval(`(() => {
    const g = localStorage.getItem('dtray.guest.v1');
    const rows = document.querySelectorAll('.file-row');
    const logo = document.querySelector('.brand img');
    const vis = logo ? getComputedStyle(logo).display : 'none';
    return JSON.stringify({
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      readyState: document.readyState,
      guestSaved: !!g,
      guestId: g ? JSON.parse(g).guestId : null,
      fileRows: rows.length,
      navItems: document.querySelectorAll('.nav-item').length,
      activeNav: document.querySelector('.nav-item.active')?.dataset?.view,
      title: document.querySelector('#viewTitle')?.textContent,
      logoVisible: vis,
      logoSrc: logo?.getAttribute('src'),
      logoNatural: logo ? logo.naturalWidth + 'x' + logo.naturalHeight : null,
      emptyVisible: getComputedStyle(document.querySelector('#empty')).display,
      storageUsed: document.querySelector('#storageUsed')?.textContent,
      guestLabel: document.querySelector('#guestIdLabel')?.textContent,
      errorLogShown: document.querySelector('#log').classList.contains('show'),
      logText: document.querySelector('#logBody')?.textContent?.slice(0,200) || '',
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
    }, null, 2);
  })()`);
  console.log('\n=== DOM PROBE (default theme) ===\n' + probe);

  await cdp.shot(path.join(OUTDIR, 'dtray-default.png'));

  // ---- force dark ----
  await cdp.eval(`localStorage.setItem('dtray.theme','dark'); location.reload(); 'ok'`);
  await sleep(SETTLE_MS);
  const darkProbe = await cdp.eval(`(() => {
    const logo = document.querySelector('.brand img:not([style*="none"])');
    const shown = Array.from(document.querySelectorAll('.brand img')).find(i => getComputedStyle(i).display !== 'none');
    return JSON.stringify({
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
      logoShownSrc: shown?.getAttribute('src'),
      rootClass: document.documentElement.className,
      fileRows: document.querySelectorAll('.file-row').length,
      guestLabel: document.querySelector('#guestIdLabel')?.textContent,
    }, null, 2);
  })()`);
  console.log('\n=== DOM PROBE (forced dark) ===\n' + darkProbe);
  await cdp.shot(path.join(OUTDIR, 'dtray-dark.png'));

  // ---- force light ----
  await cdp.eval(`localStorage.setItem('dtray.theme','light'); location.reload(); 'ok'`);
  await sleep(SETTLE_MS);
  const lightProbe = await cdp.eval(`(() => {
    const shown = Array.from(document.querySelectorAll('.brand img')).find(i => getComputedStyle(i).display !== 'none');
    return JSON.stringify({
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyFg: getComputedStyle(document.body).color,
      logoShownSrc: shown?.getAttribute('src'),
    }, null, 2);
  })()`);
  console.log('\n=== DOM PROBE (forced light) ===\n' + lightProbe);
  await cdp.shot(path.join(OUTDIR, 'dtray-light.png'));

  // ---- grid view ----
  await cdp.eval(`document.querySelector('#viewGrid').click(); 'ok'`);
  await sleep(600);
  await cdp.shot(path.join(OUTDIR, 'dtray-grid.png'));

  // ---- mobile ----
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 420, height: 860, deviceScaleFactor: 1, mobile: true,
  });
  await cdp.eval(`document.querySelector('#viewList').click(); 'ok'`);
  await sleep(700);
  const mobileProbe = await cdp.eval(`JSON.stringify({ innerWidth: innerWidth, sidebarTransform: getComputedStyle(document.querySelector('#sidebar')).transform })`);
  console.log('\n=== MOBILE PROBE ===\n' + mobileProbe);
  await cdp.shot(path.join(OUTDIR, 'dtray-mobile.png'));

  console.log('\n--- errors ---');
  console.log(cdp.errors.length ? cdp.errors.slice(0, 20).join('\n') : '  (none)');
  console.log('\n--- failed requests ---');
  console.log(cdp.failed.length ? cdp.failed.slice(0, 20).join('\n') : '  (none)');

  chrome.kill();
  const bad = cdp.errors.length + cdp.failed.length;
  console.log(`\n${bad === 0 ? 'CLEAN RUN' : bad + ' PROBLEM(S)'}`);
  process.exit(bad === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('FAILED:', e.message);
  try { chrome.kill(); } catch {}
  process.exit(1);
});
