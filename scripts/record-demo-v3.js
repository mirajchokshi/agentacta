#!/usr/bin/env node
/**
 * record-demo-v3.js — Polished GIF demo recorder for AgentActa
 * 
 * Self-contained: starts the demo server, captures frames via Puppeteer,
 * post-processes with ffmpeg (rounded corners, shadow, titlebar, GIF).
 * 
 * Usage: node scripts/record-demo-v3.js
 */

const puppeteer = require('puppeteer-core');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = 'http://localhost:4099';
const REPO = path.join(__dirname, '..');
const SCREENSHOTS_DIR = path.join(REPO, 'screenshots');
const FRAMES_DIR = path.join(os.tmpdir(), 'agentacta-demo-frames');
const OUT_GIF = path.join(SCREENSHOTS_DIR, 'demo.gif');
const CHROME = '/usr/bin/google-chrome-stable';

const WIDTH = 1280;
const HEIGHT = 900;
const CAPTURE_FPS = 12;
const OUTPUT_FPS = 10;
const PADDING = 32;
const CORNER_RADIUS = 16;
const TITLEBAR_HEIGHT = 28;
const BG_COLOR = '0d1117';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Server management ──────────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['index.js', '--demo'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '4099' }
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('Server start timeout'));
    }, 15000);

    const onData = (data) => {
      const line = data.toString();
      if (!started && (line.includes('listening') || line.includes('4099') || line.includes('running'))) {
        started = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    // Fallback: poll the port
    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try {
        const http = require('http');
        await new Promise((res, rej) => {
          const req = http.get('http://localhost:4099', () => { res(); });
          req.on('error', rej);
          req.setTimeout(500, () => { req.destroy(); rej(); });
        });
        started = true;
        clearTimeout(timeout);
        clearInterval(poll);
        resolve(proc);
      } catch {}
    }, 500);
  });
}

// ── Frame capture ──────────────────────────────────────────────────

let frameCount = 0;
let capturing = false;
let captureInterval = null;
let captureInFlight = false;
let pendingCapture = Promise.resolve();
let droppedCaptureTicks = 0;

function startCapture(page) {
  capturing = true;
  captureInFlight = false;
  droppedCaptureTicks = 0;
  pendingCapture = Promise.resolve();
  const ms = Math.round(1000 / CAPTURE_FPS);

  captureInterval = setInterval(() => {
    if (!capturing) return;
    // Backpressure: if a capture is still running, skip this tick.
    if (captureInFlight) {
      droppedCaptureTicks++;
      return;
    }

    const num = String(frameCount++).padStart(5, '0');
    captureInFlight = true;

    pendingCapture = page.screenshot({
      path: path.join(FRAMES_DIR, `frame-${num}.png`),
      type: 'png'
    })
      .catch((err) => {
        console.warn(`  ⚠️ Screenshot failed for frame ${num}: ${err.message}`);
      })
      .finally(() => {
        captureInFlight = false;
      });
  }, ms);
}

async function stopCapture() {
  capturing = false;
  if (captureInterval) clearInterval(captureInterval);
  // Ensure last in-flight frame is fully written before post-processing starts.
  await pendingCapture;
}

// ── Interaction script ─────────────────────────────────────────────

async function runWalkthrough(page) {
  // Set OLED theme
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'oled');
  });
  await sleep(500);

  // Wait for overview to load (it's the default view)
  await page.waitForSelector('.stat-grid', { timeout: 10000 });
  await sleep(300);

  // Scene 1: Overview — stats cards and recent sessions
  console.log('  📍 Scene 1: Overview (stats + recent sessions)');
  startCapture(page);
  await sleep(2500);

  // Scene 2: Open Cmd+K and search for "docker"
  console.log('  📍 Scene 2: Cmd+K search "docker"');
  await page.evaluate(() => openCmdk());
  await sleep(600);
  await page.waitForSelector('#cmdkInput', { timeout: 3000 });
  const cmdkInput = await page.$('#cmdkInput');
  for (const char of 'docker') {
    await cmdkInput.type(char, { delay: 90 });
  }
  await sleep(1800);
  // Close palette
  await page.keyboard.press('Escape');
  await sleep(500);

  // Scene 3: Navigate to Sessions
  console.log('  📍 Scene 3: Sessions view');
  await page.evaluate(() => document.querySelector('[data-view="sessions"]').click());
  await sleep(2000);

  // Scene 4: Click into a session
  console.log('  📍 Scene 4: Session detail');
  await page.waitForSelector('.session-item', { timeout: 5000 });
  await sleep(300);
  await page.evaluate(() => document.querySelector('.session-item').click());
  await sleep(1500);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(1000);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(1000);

  // Scene 5: Insights
  console.log('  📍 Scene 5: Insights');
  await page.evaluate(() => document.querySelector('[data-view="insights"]').click());
  await sleep(2000);
  // Tap a lollipop row to reveal description
  await page.evaluate(() => {
    const row = document.querySelector('.signal-lollipop-expandable');
    if (row) row.click();
  });
  await sleep(1200);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(1500);

  // Scene 6: Timeline
  console.log('  📍 Scene 6: Timeline');
  await page.evaluate(() => document.querySelector('[data-view="timeline"]').click());
  await sleep(2000);
  await page.evaluate(() => window.scrollBy(0, 250));
  await sleep(1500);

  // Scene 7: Files
  console.log('  📍 Scene 7: Files');
  await page.evaluate(() => document.querySelector('[data-view="files"]').click());
  await sleep(1500);
  await page.evaluate(() => {
    const toggle = document.getElementById('groupToggle');
    if (toggle) toggle.click();
  });
  await sleep(2000);

  // Scene 8: Back to overview
  console.log('  📍 Scene 8: Back to overview');
  await page.evaluate(() => document.querySelector('[data-view="overview"]').click());
  await sleep(1500);

  await stopCapture();
  console.log(`\n  📸 Captured ${frameCount} frames`);
  if (droppedCaptureTicks > 0) {
    console.log(`  ℹ️ Dropped ${droppedCaptureTicks} capture ticks due to backpressure`);
  }
}

// ── FFmpeg post-processing ─────────────────────────────────────────

function postProcess() {
  console.log('🎞️  Post-processing...');

  const CANVAS_W = WIDTH + PADDING * 2;
  const CANVAS_H = HEIGHT + PADDING * 2 + TITLEBAR_HEIGHT;
  const CONTENT_Y = PADDING + TITLEBAR_HEIGHT;

  const rawMp4 = path.join(FRAMES_DIR, 'raw.mp4');
  const composedMp4 = path.join(FRAMES_DIR, 'composed.mp4');
  const palette = path.join(FRAMES_DIR, 'palette.png');

  // Step 1: Stitch frames into raw mp4
  console.log('  → Stitching frames...');
  execSync(`ffmpeg -y -framerate ${CAPTURE_FPS} -i "${FRAMES_DIR}/frame-%05d.png" -c:v libx264 -pix_fmt yuv420p -preset fast "${rawMp4}"`, { stdio: 'pipe' });

  // Step 2: Compose with titlebar, rounded corners, dark background
  // Strategy: use drawbox for dots (squares, but small enough to look round),
  // and alpha masks for rounded corners on the combined window frame
  console.log('  → Composing with window chrome + dark bg...');

  // Build a simpler but reliable filter:
  // 1. Create background canvas
  // 2. Create titlebar strip with traffic light dots
  // 3. Stack titlebar + video vertically
  // 4. Apply rounded corners to the combined window
  // 5. Overlay on dark background
  const winH = HEIGHT + TITLEBAR_HEIGHT;
  const r = CORNER_RADIUS;
  const dotY = Math.floor(TITLEBAR_HEIGHT / 2 - 5);

  const filterComplex = [
    // Dark background
    `color=c=0x${BG_COLOR}:s=${CANVAS_W}x${CANVAS_H}:r=${CAPTURE_FPS}:d=999[bg]`,
    // Titlebar strip
    `color=c=0x161b22:s=${WIDTH}x${TITLEBAR_HEIGHT}:r=${CAPTURE_FPS}:d=999[tbar]`,
    // Add traffic light dots to titlebar
    `[tbar]drawbox=x=12:y=${dotY}:w=10:h=10:color=0xff5f57:t=fill,drawbox=x=30:y=${dotY}:w=10:h=10:color=0xfebc2e:t=fill,drawbox=x=48:y=${dotY}:w=10:h=10:color=0x28c840:t=fill[tbar_d]`,
    // Stack titlebar on top of video
    `[tbar_d][0:v]vstack=inputs=2[window]`,
    // Create rounded corner mask
    `color=c=white:s=${WIDTH}x${winH}:r=${CAPTURE_FPS}:d=999,format=yuva420p,` +
    `geq=lum='255':cb='128':cr='128':a='` +
      // top-left corner
      `if(lt(X,${r})*lt(Y,${r}), if(lte(hypot(${r}-X,${r}-Y),${r}),255,0), ` +
      // top-right corner
      `if(gt(X,W-${r})*lt(Y,${r}), if(lte(hypot(X-(W-${r}),${r}-Y),${r}),255,0), ` +
      // bottom-left corner
      `if(lt(X,${r})*gt(Y,H-${r}), if(lte(hypot(${r}-X,Y-(H-${r})),${r}),255,0), ` +
      // bottom-right corner
      `if(gt(X,W-${r})*gt(Y,H-${r}), if(lte(hypot(X-(W-${r}),Y-(H-${r})),${r}),255,0), ` +
      // everything else
      `255))))` +
    `'[mask]`,
    // Apply mask to window
    `[window][mask]alphamerge[masked]`,
    // Overlay masked window on background
    `[bg][masked]overlay=${PADDING}:${PADDING}:format=auto[out]`
  ].join(';');

  try {
    execSync(
      `ffmpeg -y -i "${rawMp4}" -filter_complex "${filterComplex}" -map "[out]" -c:v libx264 -pix_fmt yuv420p -preset fast -shortest "${composedMp4}"`,
      { stdio: 'pipe' }
    );
  } catch (err) {
    // If complex filter fails, fall back to simpler composition
    console.log('  ⚠️  Complex filter failed, using simpler composition...');
    const simpleFc = [
      `color=c=0x${BG_COLOR}:s=${CANVAS_W}x${CANVAS_H}:r=${CAPTURE_FPS}:d=999[bg]`,
      `color=c=0x161b22:s=${WIDTH}x${TITLEBAR_HEIGHT}:r=${CAPTURE_FPS}:d=999[tbar]`,
      `[tbar]drawbox=x=12:y=${dotY}:w=10:h=10:color=0xff5f57:t=fill,drawbox=x=30:y=${dotY}:w=10:h=10:color=0xfebc2e:t=fill,drawbox=x=48:y=${dotY}:w=10:h=10:color=0x28c840:t=fill[tbar_d]`,
      `[tbar_d][0:v]vstack=inputs=2[window]`,
      `[bg][window]overlay=${PADDING}:${PADDING}:shortest=1[out]`
    ].join(';');
    execSync(
      `ffmpeg -y -i "${rawMp4}" -filter_complex "${simpleFc}" -map "[out]" -c:v libx264 -pix_fmt yuv420p -preset fast -shortest "${composedMp4}"`,
      { stdio: 'pipe' }
    );
  }

  // Step 3: Two-pass palette generation for optimized GIF
  console.log('  → Generating palette...');
  execSync(
    `ffmpeg -y -i "${composedMp4}" -vf "fps=${OUTPUT_FPS},palettegen=max_colors=128:stats_mode=diff" "${palette}"`,
    { stdio: 'pipe' }
  );

  console.log('  → Encoding GIF...');
  execSync(
    `ffmpeg -y -i "${composedMp4}" -i "${palette}" -lavfi "fps=${OUTPUT_FPS}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "${OUT_GIF}"`,
    { stdio: 'pipe' }
  );

  const stat = fs.statSync(OUT_GIF);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  console.log(`  ✅ GIF: ${OUT_GIF} (${sizeMB} MB)`);

  // If over 8MB, try more aggressive optimization
  if (stat.size > 8 * 1024 * 1024) {
    console.log('  ⚠️  Over 8MB, re-encoding at smaller scale...');
    const smallW = Math.round(CANVAS_W * 0.75);
    execSync(
      `ffmpeg -y -i "${composedMp4}" -vf "fps=${OUTPUT_FPS},scale=${smallW}:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff" "${palette}"`,
      { stdio: 'pipe' }
    );
    execSync(
      `ffmpeg -y -i "${composedMp4}" -i "${palette}" -lavfi "fps=${OUTPUT_FPS},scale=${smallW}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" "${OUT_GIF}"`,
      { stdio: 'pipe' }
    );
    const stat2 = fs.statSync(OUT_GIF);
    console.log(`  ✅ GIF (reduced): ${(stat2.size / (1024 * 1024)).toFixed(2)} MB`);
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 AgentActa Demo Recorder v3\n');

  // Prep directories
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  // Start demo server
  console.log('🖥️  Starting demo server...');
  const server = await startServer();
  console.log('  ✅ Server ready on port 4003\n');

  let browser;
  try {
    // Launch browser
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--window-size=${WIDTH},${HEIGHT}`,
        '--disable-gpu',
        '--hide-scrollbars'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });

    console.log('🌐 Loading AgentActa...');
    await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
    await sleep(500);

    console.log('🎬 Recording walkthrough...\n');
    await runWalkthrough(page);

    console.log('🎬 Recording complete, closing browser...');
    await browser.close();
    browser = null;

    // Post-process
    postProcess();

    // Cleanup frames
    console.log('🧹 Cleaning up temp frames...');
    fs.rmSync(FRAMES_DIR, { recursive: true, force: true });

  } catch (err) {
    console.error('❌ Error:', err);
    if (browser) await browser.close().catch(() => {});
    throw err;
  } finally {
    // Kill server
    server.kill('SIGTERM');
    console.log('🖥️  Server stopped');
  }

  console.log('\n🎉 Done! Output: screenshots/demo.gif');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
