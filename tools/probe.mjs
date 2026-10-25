/**
 * probe.mjs — report computed layout metrics from the live page.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.PORT || 9336);
const CHROME = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dtray-probe-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--hide-scrollbars',
  '--force-device-scale-factor=1', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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

  const out = await cdp.eval(`(() => {
    const r = el => { const b = el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}; };
    const cs = (el, p) => getComputedStyle(el).getPropertyValue(p);
    const scroll = document.querySelector('.panel-scroll');
    const rec = document.querySelector('.recents');
    const card = document.querySelector('.rcard');
    const row = document.querySelector('.frow');
    const thead = document.querySelector('.thead');
    return JSON.stringify({
      panel: r(document.querySelector('.panel')),
      panelScroll: r(scroll),
      scrollPad: cs(scroll,'padding'),
      recents: r(rec),
      recentsCols: cs(rec,'grid-template-columns'),
      card: card ? r(card) : null,
      cardCount: document.querySelectorAll('.rcard').length,
      row: row ? r(row) : null,
      thead: r(thead),
      theadCols: cs(thead,'grid-template-columns'),
      side: r(document.querySelector('.side')),
      top: r(document.querySelector('.top')),
      searchBox: r(document.querySelector('.search')),
      newBtn: r(document.querySelector('.new-btn')),
      navItem: r(document.querySelector('.nav-item.on')),
      title: r(document.querySelector('#title')),
      firstFileIcon: r(document.querySelector('.frow .fic')),
      fontBody: cs(document.body,'font-family').slice(0,40),
    }, null, 2);
  })()`);
  console.log(out);
  chrome.kill();
  process.exit(0);
})().catch(e => { console.error('FAILED', e.message); try { chrome.kill(); } catch {} process.exit(1); });
