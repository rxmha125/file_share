/**
 * states.mjs — capture the empty state and the error banner.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.PORT || 9337);
const CHROME = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dtray-states-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--hide-scrollbars',
  '--force-device-scale-factor=1', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
  async shot(f) {
    const s = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    console.log('wrote', f);
  }
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(200);
  }
  let page;
  for (let i = 0; i < 60; i++) {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
    await sleep(250);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/' });
  await sleep(5000);

  // ---- empty state ----
  await cdp.eval(`(() => {
    state.files = [];
    render();
    return 'ok';
  })()`);
  await sleep(500);
  const emptyProbe = await cdp.eval(`(() => {
    const e = document.querySelector('#empty');
    const b = e.getBoundingClientRect();
    return JSON.stringify({
      shown: e.classList.contains('on'),
      display: getComputedStyle(e).display,
      title: document.querySelector('#emptyTitle').textContent,
      sub: document.querySelector('#emptySub').textContent,
      btnVisible: getComputedStyle(document.querySelector('#emptyBtn')).display,
      height: Math.round(b.height),
    });
  })()`);
  console.log('\n=== EMPTY STATE ===\n' + emptyProbe);
  await cdp.shot('shots/dtray-empty.png');

  // ---- error banner ----
  await cdp.eval(`(() => {
    logError('Upload failed — demo.mp4', 'Chunk 3/5 rejected (HTTP 524)\\nOrigin timeout after 100s');
    return 'ok';
  })()`);
  await sleep(400);
  const errProbe = await cdp.eval(`(() => {
    const l = document.querySelector('#log');
    const b = l.getBoundingClientRect();
    return JSON.stringify({ shown: l.classList.contains('on'), w: Math.round(b.width), h: Math.round(b.height) });
  })()`);
  console.log('\n=== ERROR BANNER ===\n' + errProbe);
  await cdp.shot('shots/dtray-error.png');

  console.log('\nuncaught:', cdp.errors.length ? cdp.errors : '(none)');
  chrome.kill();
  process.exit(0);
})().catch(e => { console.error('FAILED', e.message); try { chrome.kill(); } catch {} process.exit(1); });
