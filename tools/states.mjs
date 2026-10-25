/**
 * states.mjs — capture the states Xe called out: the row dropdown and the
 * focused search field, in both themes, plus empty + error states.
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
  // headless windows are never "focused", so :focus rules need this
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3000/' });
  await sleep(5500);

  for (const theme of ['dark', 'light']) {
    await cdp.eval(`localStorage.setItem('dtray.theme','${theme}'); location.reload(); 'ok'`);
    await sleep(5000);

    // focused search
    await cdp.eval(`(() => {
      const s = document.querySelector('#search');
      s.focus();
      s.value = 'tonight';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(500);
    const searchProbe = await cdp.eval(`(() => {
      const s = document.querySelector('#search');
      const cs = getComputedStyle(s);
      return JSON.stringify({ bg: cs.backgroundColor, shadow: cs.boxShadow, fontSize: cs.fontSize, weight: cs.fontWeight });
    })()`);
    console.log(`\n[${theme}] SEARCH FOCUS -> ${searchProbe}`);
    await cdp.shot(`shots/state-search-${theme}.png`);

    // clear + open the row menu
    await cdp.eval(`(() => {
      document.querySelector('#searchClear').click();
      document.querySelector('#search').blur();
      const b = document.querySelector('.frow [data-more]');
      b.click();
      return 'ok';
    })()`);
    await sleep(500);
    const menuProbe = await cdp.eval(`(() => {
      const m = document.querySelector('#menu');
      const cs = getComputedStyle(m);
      return JSON.stringify({ bg: cs.backgroundColor, shadow: cs.boxShadow, radius: cs.borderRadius, w: Math.round(m.getBoundingClientRect().width) });
    })()`);
    console.log(`[${theme}] MENU -> ${menuProbe}`);
    await cdp.shot(`shots/state-menu-${theme}.png`);
    await cdp.eval(`document.body.click(); 'ok'`);
    await sleep(200);
  }

  console.log('\nuncaught:', cdp.errors.length ? cdp.errors : '(none)');
  chrome.kill();
  process.exit(0);
})().catch(e => { console.error('FAILED', e.message); try { chrome.kill(); } catch {} process.exit(1); });
