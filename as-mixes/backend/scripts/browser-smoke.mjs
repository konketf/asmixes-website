// Optional offline Chromium check. Uses an installed browser and Node's CDP
// WebSocket support; no browser package, production requests or email delivery.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, access, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const backend = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(backend, '../dist');
const output = path.join(backend, 'build/browser-smoke');
await mkdir(output, { recursive: true });
const candidates = [process.env.BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
assert.ok(executable, 'Set BROWSER_PATH to an installed Chromium browser.');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const baseline = process.argv.includes('--baseline');
// Serve exact checkout bytes through CDP too: local HTTP antivirus injection can
// otherwise alter the CSP/HTML being tested. No OS/browser protections are changed.
const origin = 'https://asmixes.test';
const profile = await mkdtemp(path.join(output, 'profile-'));
const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
  '--disable-sync', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket, closeBrowser;
const errors = [], logs = [], requests = [];
let scenario = 'healthy', artworkAttempts = 0, metadataAttempts = 0, contactAttempts = 0;
const art = '/media/11111111-1111-1111-1111-111111111111';
const audio = '/media/22222222-2222-2222-2222-222222222222';
const project = { title: 'Synthetic recording', artist: 'Test artist', credit: 'Mixing', description: 'Offline browser fixture.', artworkUrl: art, audioUrl: audio };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCuoAAAAASUVORK5CYII=', 'base64');
// Ten seconds of PCM silence for native playback/seek checks, never committed as media.
const wav = Buffer.alloc(44 + 44100 * 2 * 10);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await delay(100); }
  }
  assert.ok(port, 'Browser failed to start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const pending = new Map();
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  closeBrowser = () => send('Browser.close');
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      route(message.params).catch(error => errors.push(error.message));
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    else if (message.method === 'Log.entryAdded') logs.push(message.params.entry);
  };
  async function fulfill(id, status, body, type, extra = {}) {
    return send('Fetch.fulfillRequest', { requestId: id, responseCode: status,
      responseHeaders: Object.entries({ 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': origin, ...extra })
        .map(([name, value]) => ({ name, value: String(value) })), body: Buffer.from(body).toString('base64') });
  }
  async function route({ requestId, request }) {
    const url = new URL(request.url); requests.push({ url: request.url, method: request.method });
    if (url.origin === origin) {
      const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      assert.ok(file.startsWith(root + path.sep));
      try {
        const body = baseline && ['/assets/portfolio.js', '/assets/styles.css', '/assets/hero-waveform.js'].includes(url.pathname)
          ? execFileSync('git', ['show', 'HEAD:as-mixes/dist' + url.pathname], { cwd: backend }) : await readFile(file);
        return await fulfill(requestId, 200, body, mime[path.extname(file)] || 'application/octet-stream');
      }
      catch { return fulfill(requestId, 404, '', 'text/plain'); }
    }
    if (url.href === 'https://static.cloudflareinsights.com/beacon.min.js') {
      // Keep regression checks offline: do not send synthetic visits to analytics.
      return fulfill(requestId, 200, '// Offline analytics fixture.', 'text/javascript');
    }
    if (url.hostname === 'challenges.cloudflare.com') {
      if (scenario === 'verification-load-error') return send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      if (scenario === 'verification-slow') await delay(1500);
      return fulfill(requestId, 200, `window.turnstile = { render(selector, options) { window.testVerification = options; return 'fixture'; }, reset() {}, remove() {} };`, 'text/javascript');
    }
    assert.equal(url.origin, 'https://api.asmixes.com', 'Unexpected external request');
    if (url.pathname === '/api/projects') {
      metadataAttempts++;
      if (scenario === 'delayed') await delay(700);
      if (scenario === 'metadata-error') return fulfill(requestId, 503, '{}', 'application/json');
      return fulfill(requestId, 200, JSON.stringify({ projects: [project, { ...project, title: 'Second fixture', artworkUrl: art.replace('11111111-', '33333333-') }] }), 'application/json');
    }
    if (url.pathname === '/api/contact') {
      if (request.method === 'OPTIONS') return fulfill(requestId, 204, '', 'application/json', { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      contactAttempts++;
      return fulfill(requestId, scenario === 'contact-error' ? 503 : 200,
        JSON.stringify(scenario === 'contact-error' ? { error: 'Fixture delivery failure' } : { accepted: true }), 'application/json');
    }
    if (url.pathname === art) {
      artworkAttempts++;
      if (scenario === 'offline' && artworkAttempts === 1) return send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
      if (scenario === 'missing' || (scenario === 'transient' && artworkAttempts === 1)) return fulfill(requestId, scenario === 'missing' ? 404 : 503, '', 'text/plain');
      if (scenario === 'corrupt') return fulfill(requestId, 200, 'invalid image', 'image/png');
      if (scenario === 'slow-image') await delay(700);
      return fulfill(requestId, 200, png, 'image/png');
    }
    if (url.pathname === audio) {
      const range = request.headers.Range || request.headers.range;
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1;
      return fulfill(requestId, match ? 206 : 200, wav.subarray(start, end + 1), 'audio/wav', {
        'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
      });
    }
    return fulfill(requestId, 200, png, 'image/png');
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('Browser condition failed: ' + expression + '\n' + JSON.stringify({ errors, logs, requests, page: await evaluate('document.documentElement.outerHTML.slice(0, 1500)') }));
  }
  let navigation = 0;
  async function open(mode, width = 1440) {
    scenario = mode; artworkAttempts = 0; metadataAttempts = 0;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: origin + '/?case=' + (++navigation) + '#work' });
    await until(`location.search === '?case=${navigation}' && document.readyState === 'complete'`);
    await until('document.querySelector(".work-grid audio") || document.querySelector("#portfolio-retry")?.hidden === false');
  }
  async function screenshot(name) {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
  }
  async function captureLayouts(prefix) {
    const layouts = {};
    for (const width of [1440, 390]) {
      await open('healthy', width); await until('document.querySelector(".portfolio-cover img").naturalWidth > 0');
      for (const theme of ['light', 'dark']) {
        await evaluate(`window.AS_MIXES_THEME.setPreference('${theme}')`);
        await delay(100);
        const name = `${width}-${theme}`;
        layouts[name] = await evaluate(`(() => {
          const selectors = ['.header', '.hero', '#work', '.work-grid', '.portfolio-cover', '.work-info', '.work-grid audio', '#services', '#contact'];
          return Object.fromEntries(selectors.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [selector, [r.x, r.y + scrollY, r.width, r.height]]; }));
        })()`);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Horizontal overflow');
        await screenshot(`${prefix}-${name}`);
      }
    }
    await writeFile(path.join(output, `${prefix}-layouts.json`), JSON.stringify(layouts, null, 2));
    if (prefix === 'current') {
      try { assert.deepEqual(layouts, JSON.parse(await readFile(path.join(output, 'baseline-layouts.json'), 'utf8')), 'Layout changed'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  if (baseline) {
    await open('transient'); await delay(2500);
    console.log('Baseline failed-image behavior:', await evaluate('({ broken: document.querySelector(".portfolio-cover img").naturalWidth === 0, retryHidden: document.querySelector("#portfolio-retry").hidden, status: document.querySelector("#portfolio-status").textContent })'), { artworkAttempts });
    await screenshot('baseline-broken');
    await captureLayouts('baseline');
  } else {
    for (const mode of ['healthy', 'delayed', 'slow-image', 'transient', 'offline']) {
      await open(mode); await until('document.querySelector(".portfolio-cover img").naturalWidth > 0');
      assert.equal(artworkAttempts, ['transient', 'offline'].includes(mode) ? 2 : 1, mode);
      assert.equal(metadataAttempts, 1); assert.equal(await evaluate('document.querySelectorAll(".work-grid audio").length'), 2);
    }
    for (const mode of ['missing', 'corrupt']) {
      await open(mode);
      await until('document.querySelector(".artwork-status button")?.disabled === false && document.querySelector(".portfolio-cover img").hidden');
      assert.equal(artworkAttempts, 2, mode); await delay(1800); assert.equal(artworkAttempts, 2, 'Automatic retry must stop');
      assert.equal(await evaluate('document.querySelectorAll(".portfolio-cover img")[1].naturalWidth > 0'), true, 'Other artwork loads independently');
      await evaluate('window.originalPlayer = document.querySelector("audio"); originalPlayer.play()');
      await until('originalPlayer.currentTime > 0');
      const before = await evaluate('originalPlayer.currentTime');
      scenario = 'healthy';
      await evaluate('document.querySelector(".artwork-status button").focus(); document.querySelector(".artwork-status button").click()');
      await until('document.querySelector(".portfolio-cover img").naturalWidth > 0');
      assert.equal(metadataAttempts, 1); assert.equal(artworkAttempts, 3);
      assert.equal(await evaluate('originalPlayer === document.querySelector("audio") && !originalPlayer.paused'), true);
      assert.ok(await evaluate('originalPlayer.currentTime') >= before);
      assert.equal(await evaluate('document.activeElement === document.querySelector(".portfolio-cover")'), true);
      await evaluate('originalPlayer.currentTime = 6'); await until('originalPlayer.currentTime >= 6 && !originalPlayer.seeking');
      await evaluate('document.querySelectorAll("audio")[1].play()'); await until('originalPlayer.paused');
    }
    await open('metadata-error');
    assert.equal(await evaluate('document.querySelectorAll(".work-grid audio").length'), 0);
    scenario = 'healthy'; await evaluate('document.querySelector("#portfolio-retry").click()');
    await until('document.querySelectorAll(".work-grid audio").length === 2'); assert.equal(metadataAttempts, 2);

    const challengeCount = () => requests.filter(r => new URL(r.url).hostname === 'challenges.cloudflare.com').length;
    const beforeInteraction = challengeCount();
    await open('verification-slow');
    await evaluate('window.AS_MIXES_THEME.setPreference("dark")');
    await delay(300);
    assert.equal(challengeCount(), beforeInteraction, 'No Turnstile before form interaction');
    for (let i = 0; i < 80; i++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      if (await evaluate('document.querySelector("#contact-form").contains(document.activeElement)')) break;
    }
    assert.equal(await evaluate('document.querySelector("#contact-form").contains(document.activeElement)'), true);
    assert.match(await evaluate('document.querySelector("#verification-status").textContent'), /Loading/);
    await evaluate(`(() => { const f = document.querySelector('#contact-form'); f.elements.name.value = 'Test artist'; f.elements.email.value = 'artist@example.com'; f.elements.message.value = 'Offline browser enquiry.'; f.requestSubmit(); })()`);
    assert.equal(contactAttempts, 0, 'No enquiry while loading');
    await until('window.testVerification');
    assert.equal(challengeCount(), beforeInteraction + 1);
    for (const callback of ['error-callback', 'expired-callback', 'timeout-callback']) {
      await evaluate(`testVerification.callback('test'); testVerification['${callback}'](); document.querySelector('#contact-form').requestSubmit()`);
      assert.equal(contactAttempts, 0, 'No enquiry after unsuccessful verification');
      assert.equal(await evaluate('document.querySelector("#contact-form button[type=submit]").disabled'), true);
      assert.match(await evaluate('document.querySelector("#verification-status").textContent'), /unavailable|expired|timed out/);
    }
    for (const touch of [false, true]) {
      await open(touch ? 'verification-load-error' : 'healthy', touch ? 390 : 1440);
      const beforePointer = challengeCount();
      await evaluate('document.querySelector("#contact-form input").scrollIntoView({block:"center"})');
      const point = await evaluate('(() => { const r = document.querySelector("#contact-form input").getBoundingClientRect(); return {x:r.x + 10, y:r.y + 10}; })()');
      if (touch) {
        await send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      }
      if (touch) {
        await until('document.querySelector("#verification-status").textContent.includes("could not load")');
        assert.equal(await evaluate('document.querySelector("#contact-form button[type=submit]").disabled'), true);
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      } else await until('window.testVerification');
      assert.equal(challengeCount(), beforePointer + 1, 'Only one script after pointer and focus');
      assert.equal(await evaluate('document.querySelector("#verification-status").getAttribute("role")'), 'status');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    }
    await open('healthy');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await evaluate('document.querySelector("#contact-form input").focus()');
    await until('window.testVerification');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate('window.AS_MIXES_THEME.setPreference("system")');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await until('document.documentElement.dataset.theme === "dark"');
    await evaluate('window.AS_MIXES_THEME.setPreference("light")');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');

    scenario = 'contact-error';
    await evaluate(`(() => { const f = document.querySelector('#contact-form'); f.elements.name.value = 'Test artist'; f.elements.email.value = 'artist@example.com'; f.elements.message.value = 'Offline browser enquiry.'; testVerification.callback('test-token'); f.requestSubmit(); })()`);
    await until('document.querySelector("#form-status").textContent === "Fixture delivery failure"');
    assert.equal(await evaluate('document.querySelector("#contact-form").elements.message.value'), 'Offline browser enquiry.');
    scenario = 'healthy'; await evaluate('testVerification.callback("fresh-token"); document.querySelector("#contact-form").requestSubmit()');
    await until('document.querySelector("#form-status").textContent.includes("has been accepted")');
    assert.equal(contactAttempts, 2); assert.equal(await evaluate('document.querySelector("#contact-form").elements.message.value'), '');

    await captureLayouts('current');
    await evaluate('document.querySelector(".menu-toggle").click()');
    assert.equal(await evaluate('document.querySelector(".menu-toggle").getAttribute("aria-expanded")'), 'true');
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
    assert.equal(await evaluate('document.querySelector(".menu-toggle").getAttribute("aria-expanded")'), 'false');
    console.log('Verified: bounded image recovery, missing/corrupt artwork, playback/seeking/exclusive audio, metadata retry, contact failure/success, themes, mobile navigation, and unchanged layout geometry.');
  }
  assert.deepEqual(errors, [], 'Browser exceptions/unhandled rejections');
  assert.deepEqual(logs.filter(entry => /Content Security Policy|Refused to/.test(entry.text)), [], 'CSP violations');
  console.log('Offline Chromium checks passed. Expected failed-resource console messages:', logs.filter(entry => entry.level === 'error').length);
} finally {
  await closeBrowser?.().catch(() => {});
  socket?.close(); browser.kill();
  // Only delete the temporary profile created by this invocation.
  assert.ok(path.resolve(profile).startsWith(path.resolve(output) + path.sep + 'profile-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
