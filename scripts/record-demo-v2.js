#!/usr/bin/env node
const puppeteer = require('puppeteer-core');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const path = require('path');

const BASE = 'http://localhost:4003';
const OUT = path.join(__dirname, '..', 'screenshots', 'demo-v2.mp4');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1280,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    ffmpeg_Path: null,
    videoFrame: { width: 1280, height: 900 },
    aspectRatio: '16:9'
  });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(1500);

  await recorder.start(OUT);
  console.log('🎬 Recording started');

  // Scene 1: Search home — "This is AgentActa..." (0-4s)
  await sleep(4000);

  // Scene 2: Type "docker" search (4-10s)
  await page.click('#searchInput');
  for (const char of 'docker') {
    await page.type('#searchInput', char, { delay: 100 });
  }
  await sleep(4000);

  // Scene 3: Clear, search "error" (10-16s)
  await page.evaluate(() => document.getElementById('searchInput').value = '');
  await page.click('#searchInput');
  for (const char of 'timeout error') {
    await page.type('#searchInput', char, { delay: 80 });
  }
  await sleep(3500);

  // Scene 4: Sessions view (16-21s)
  await page.evaluate(() => document.querySelector('[data-view="sessions"]').click());
  await sleep(5000);

  // Scene 5: Click into session detail (21-28s)
  await page.evaluate(() => document.querySelector('.session-item').click());
  await sleep(3000);
  await page.evaluate(() => window.scrollBy(0, 350));
  await sleep(2000);
  await page.evaluate(() => window.scrollBy(0, 350));
  await sleep(2000);

  // Scene 6: Timeline (28-33s)
  await page.evaluate(() => document.querySelector('[data-view="timeline"]').click());
  await sleep(2500);
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(2500);

  // Scene 7: Files (33-38s)
  await page.evaluate(() => document.querySelector('[data-view="files"]').click());
  await sleep(2000);
  await page.evaluate(() => document.getElementById('groupToggle').click());
  await sleep(3000);

  // Scene 8: Stats (38-43s)
  await page.evaluate(() => document.querySelector('[data-view="stats"]').click());
  await sleep(4000);

  // Scene 9: Back to search — closing (43-46s)
  await page.evaluate(() => document.querySelector('[data-view="search"]').click());
  await sleep(3000);

  await recorder.stop();
  console.log(`🎬 Done: ${OUT}`);
  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
