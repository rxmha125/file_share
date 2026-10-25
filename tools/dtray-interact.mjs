/**
 * dtray-interact.mjs — drive the real UI: open the row menu, use search,
 * switch nav views, and perform an actual upload through the browser.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_ = 'http://127.0.0.1:3000/';
const PORT = Number(process.env.PORT || 9335);
const W = 1440, H = 900;
const CHROME = process.env.CHROME ||
  path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dtray-int-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('devtools never came up');
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
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        this.errors.push(`[${m.params.entry.source}] ${m.params.entry.text}`);
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
    console.log(`wrote ${file}`);
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
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) return p;
    await sleep(250);
  }
  throw new Error('no page target');
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(6000);

  // ---------- 1. open the row action menu on the first row ----------
  const moreBox = await cdp.eval(`(() => {
    const b = document.querySelector('.file-row [data-more]');
    if (!b) return null;
    b.scrollIntoView({block:'center'});
    const r = b.getBoundingClientRect();
    return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
  })()`);
  if (moreBox) {
    const { x, y } = JSON.parse(moreBox);
    // hover the row first so the button becomes visible
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 200, y });
    await sleep(150);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(400);
    await cdp.eval(`document.querySelector('.file-row [data-more]').click(); 'ok'`);
    await sleep(500);
    const menuProbe = await cdp.eval(`(() => {
      const m = document.querySelector('#menu');
      const r = m.getBoundingClientRect();
      return JSON.stringify({
        shown: m.classList.contains('show'),
        display: getComputedStyle(m).display,
        items: Array.from(m.querySelectorAll('button[data-act]')).map(b => b.dataset.act),
        inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      });
    })()`);
    console.log('\n=== ROW MENU PROBE ===\n' + menuProbe);
    await cdp.shot(path.join(OUTDIR, 'dtray-menu.png'));
    await cdp.eval(`document.body.click(); 'ok'`);
    await sleep(200);
  }

  // ---------- 2. search ----------
  await cdp.eval(`(() => {
    const s = document.querySelector('#search');
    s.value = 'mp4';
    s.dispatchEvent(new Event('input', {bubbles:true}));
    'ok';
  })()`);
  await sleep(600);
  const searchProbe = await cdp.eval(`JSON.stringify({
    title: document.querySelector('#viewTitle').textContent,
    sub: document.querySelector('#viewSub').textContent,
    rows: document.querySelectorAll('.file-row').length,
    allMatch: Array.from(document.querySelectorAll('.file-name')).every(n => n.textContent.toLowerCase().includes('mp4')),
  })`);
  console.log('\n=== SEARCH PROBE ===\n' + searchProbe);
  await cdp.shot(path.join(OUTDIR, 'dtray-search.png'));
  await cdp.eval(`document.querySelector('#searchClear').click(); 'ok'`);
  await sleep(400);

  // ---------- 3. nav views ----------
  const navProbe = await cdp.eval(`(() => {
    const out = {};
    for (const item of document.querySelectorAll('.nav-item')) {
      item.click();
      out[item.dataset.view] = document.querySelectorAll('.file-row').length;
    }
    document.querySelector('.nav-item[data-view="my"]').click();
    return JSON.stringify(out);
  })()`);
  console.log('\n=== NAV VIEW COUNTS ===\n' + navProbe);

  // ---------- 4. real upload through the browser ----------
  const upProbe = await cdp.eval(`(async () => {
    const res = await fetch('/api/guest/verify', {
      headers: (() => { const g = JSON.parse(localStorage.getItem('dtray.guest.v1')); return {'x-guest-id': g.guestId, 'x-guest-token': g.token}; })()
    });
    const body = new FormData();
    body.append('f', new Blob(['dtray browser upload test 12345'], {type:'text/plain'}), 'browser-upload-test.txt');
    const gid = JSON.parse(localStorage.getItem('dtray.guest.v1')).guestId;
    const tok = JSON.parse(localStorage.getItem('dtray.guest.v1')).token;
    const r = await fetch('/api/upload?name=browser-upload-test.txt&type=text/plain', {
      method: 'POST',
      headers: {'x-guest-id': gid, 'x-guest-token': tok, 'Content-Type': 'text/plain'},
      body: 'dtray browser upload test 12345'
    });
    const j = await r.json();
    return JSON.stringify({ verifyStatus: res.status, uploadStatus: r.status, upload: j });
  })()`, true);
  console.log('\n=== UPLOAD PROBE ===\n' + upProbe);
  await sleep(1500);
  await cdp.eval(`window.dispatchEvent(new Event('focus')); 'ok'`);
  await sleep(2500);
  const afterUpload = await cdp.eval(`JSON.stringify({
    firstFile: document.querySelector('.file-name')?.textContent,
    rows: document.querySelectorAll('.file-row').length,
    toast: document.querySelector('#toast').textContent,
  })`);
  console.log('\n=== AFTER UPLOAD ===\n' + afterUpload);
  await cdp.shot(path.join(OUTDIR, 'dtray-after-upload.png'));

  console.log('\n--- errors ---');
  console.log(cdp.errors.length ? cdp.errors.slice(0, 10).join('\n') : '  (none)');
  console.log('--- failed requests ---');
  console.log(cdp.failed.length ? cdp.failed.slice(0, 10).join('\n') : '  (none)');

  chrome.kill();
  process.exit(0);
};

main().catch((e) => { console.error('FAILED:', e.message); try { chrome.kill(); } catch {} process.exit(1); });
