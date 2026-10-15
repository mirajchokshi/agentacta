#!/usr/bin/env node
/**
 * record-demo.js - Record the README demo (MP4 + GIF) from the seeded demo data.
 *
 * Self-contained and dependency-free: re-seeds demo/ with fictional sessions,
 * starts `node index.js --demo` on a spare port with a fresh demo.db, drives
 * Chrome over the DevTools protocol, then frames and encodes with ffmpeg.
 * Only demo data is shown; nothing from the machine's real sessions.
 *
 * Usage: npm run build && node scripts/record-demo.js
 * Needs: Google Chrome (CHROME env to override the path) and ffmpeg.
 * Writes: screenshots/demo.mp4 and screenshots/demo.gif
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');
const PORT = Number(process.env.DEMO_PORT || 4099);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(REPO, 'screenshots');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'agentacta-demo-'));
const FRAMES = path.join(WORK, 'frames');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));

const WIDTH = 1280;
const HEIGHT = 800;
const FPS = 12;
const PADDING = 32;
const TITLEBAR = 28;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -- Demo data + server -----------------------------------------------------

function seed() {
  // demo/ is gitignored, so it doesn't exist on a fresh clone.
  fs.mkdirSync(path.join(REPO, 'demo'), { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, 'demo')).filter(f => f.startsWith('demo.db'))) {
    fs.unlinkSync(path.join(REPO, 'demo', f));
  }
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'seed-demo.js')], { stdio: 'inherit' });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['index.js', '--demo'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(PORT), AGENTACTA_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`demo server did not start:\n${out}`)), 30000);
    const onData = d => {
      out += d;
      if (out.includes('running on')) { clearTimeout(timer); resolve(proc); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`demo server exited (${code}):\n${out}`)); });
  });
}

// -- Chrome over the DevTools protocol --------------------------------------

async function launchChrome() {
  if (!CHROME) throw new Error('Chrome not found; set CHROME=/path/to/chrome');
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, '--no-first-run', '--hide-scrollbars',
    `--user-data-dir=${path.join(WORK, 'profile')}`, `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(100);
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('could not connect to Chrome');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  return { proc, ws, send };
}

// -- Walkthrough --------------------------------------------------------------

async function walkthrough(cdp) {
  const run = expr => cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true });
  const hover = async sel => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const b=el.getBoundingClientRect(); return [b.x+b.width/2,b.y+b.height/2]})()`, returnByValue: true });
    const xy = r.result && r.result.result && r.result.result.value;
    if (xy) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy[0], y: xy[1] });
  };
  const key = async k => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, windowsVirtualKeyCode: k === 'Escape' ? 27 : undefined });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
  };
  const scrollTo = async (y, steps = 12) => {
    for (let i = 1; i <= steps; i++) { await run(`window.scrollTo(0, window.scrollY + (${y} - window.scrollY) * ${i / steps})`); await sleep(30); }
  };

  console.log('  scene: overview');
  await sleep(2200);
  await hover('.colchart .col:last-child');
  await sleep(1600);
  await hover('body');
  await scrollTo(330);
  await sleep(2000);

  console.log('  scene: sessions with nested subagents');
  await scrollTo(0, 6);
  await run(`document.querySelector('[data-view="sessions"]').click()`);
  await sleep(2400);
  await hover('.subagent-list .subagent-row');
  await sleep(1600);
  await hover('.session-list > .session-group .session-item');
  await sleep(1000);

  console.log('  scene: live session detail');
  await run(`document.querySelector('.session-list .session-item').click()`);
  await sleep(2800);
  await scrollTo(380);
  await sleep(1500);
  await run(`(()=>{const d=[...document.querySelectorAll('.tool-detail')].find(x=>x.getBoundingClientRect().top>200); if(d){d.open=true;}})()`);
  await sleep(1800);

  console.log('  scene: back + keyboard');
  await key('Escape');
  await sleep(1500);
  for (let i = 0; i < 4; i++) { await key('j'); await sleep(450); }
  await sleep(800);

  console.log('  scene: timeline');
  await run(`document.querySelector('[data-view="timeline"]').click()`);
  await sleep(2400);
  await scrollTo(300);
  await sleep(1400);

  console.log('  scene: insights');
  await run(`document.querySelector('[data-view="insights"]').click()`);
  await sleep(2600);

  console.log('  scene: search');
  await run('openCmdk()');
  await sleep(700);
  for (const ch of 'forecast') { await cdp.send('Input.insertText', { text: ch }); await sleep(90); }
  await sleep(2200);
  await key('Escape');
  await sleep(500);

  console.log('  scene: light theme');
  await run(`document.querySelector('[data-view="overview"]').click()`);
  await sleep(1400);
  await run(`document.getElementById('theme-toggle').click()`);
  await sleep(2600);
}

// Screenshots on a fixed tick while the walkthrough runs; each frame keeps
// its capture time so the encoder can hold it for the right duration.
function startCapture(cdp) {
  fs.mkdirSync(FRAMES, { recursive: true });
  const frames = [];
  let stop = false;
  const done = (async () => {
    while (!stop) {
      const t = Date.now();
      const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
      const file = path.join(FRAMES, `f${String(frames.length).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      frames.push({ file, t });
      const wait = 1000 / FPS - (Date.now() - t);
      if (wait > 0) await sleep(wait);
    }
  })();
  return async () => { stop = true; await done; return frames; };
}

// -- Encode ---------------------------------------------------------------------

function encode(frames) {
  const list = path.join(WORK, 'frames.txt');
  const lines = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1] ? frames[i + 1].t : f.t + 1000 / FPS;
    lines.push(`file '${f.file}'`, `duration ${((next - f.t) / 1000).toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(list, lines.join('\n'));

  const W = WIDTH + PADDING * 2;
  const H = HEIGHT + TITLEBAR + PADDING * 2;
  const dotY = Math.floor(TITLEBAR / 2 - 5);
  const frame = [
    `color=c=0x0d0e10:s=${W}x${H}:r=${FPS}[bg]`,
    `color=c=0x1b1d21:s=${WIDTH}x${TITLEBAR}:r=${FPS}[tb]`,
    `[tb]drawbox=x=12:y=${dotY}:w=10:h=10:color=0xff5f57:t=fill,drawbox=x=30:y=${dotY}:w=10:h=10:color=0xfebc2e:t=fill,drawbox=x=48:y=${dotY}:w=10:h=10:color=0x28c840:t=fill[tbd]`,
    `[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT}[v]`,
    `[tbd][v]vstack=inputs=2:shortest=1[win]`,
    `[bg][win]overlay=${PADDING}:${PADDING}:shortest=1,format=yuv420p[out]`,
  ].join(';');
  const mp4 = path.join(OUT_DIR, 'demo.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-filter_complex', frame, '-map', '[out]', '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', mp4]);

  const palette = path.join(WORK, 'palette.png');
  const gif = path.join(OUT_DIR, 'demo.gif');
  const gifW = 960;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `fps=10,scale=${gifW}:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff`, palette]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-i', palette, '-lavfi', `fps=10,scale=${gifW}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
  return { mp4, gif };
}

// -- Main -----------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Seeding fictional demo data...');
  seed();
  console.log(`Starting demo server on ${BASE}...`);
  const server = await startServer();
  const cdp = await launchChrome();
  try {
    await cdp.send('Page.navigate', { url: `${BASE}/#overview` });
    await sleep(2500);
    await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('agentacta-theme-mode','dark'); localStorage.setItem('agentacta-dark-variant','default'); location.reload()` });
    await sleep(3000);
    console.log('Recording...');
    const stop = startCapture(cdp);
    await walkthrough(cdp);
    const frames = await stop();
    console.log(`Captured ${frames.length} frames; encoding...`);
    const { mp4, gif } = encode(frames);
    for (const f of [mp4, gif]) console.log(`  ${path.relative(REPO, f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
  } finally {
    try { cdp.ws.close(); } catch {}
    await new Promise(r => { cdp.proc.once('exit', r); cdp.proc.kill(); setTimeout(r, 3000); });
    server.kill();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => { console.error(err); process.exit(1); });
