#!/usr/bin/env node
const puppeteer = require('puppeteer-core');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const path = require('path');

const BASE = 'http://localhost:4003';
const OUT = path.join(__dirname, '..', 'screenshots', 'demo.mp4');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function typeSlowly(page, selector, text, delay = 80) {
  await page.click(selector);
  for (const char of text) {
    await page.type(selector, char, { delay });
  }
}

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
  await sleep(1000);

  await recorder.start(OUT);
  console.log('🎬 Recording started');

  // 1. Search home — pause to show overview
  await sleep(2500);

  // 2. Type a search query
  await typeSlowly(page, '#searchInput', 'docker', 120);
  await sleep(2500);

  // 3. Clear and try another search
  await page.evaluate(() => document.getElementById('searchInput').value = '');
  await typeSlowly(page, '#searchInput', 'timeout', 120);
  await sleep(2000);

  // 4. Navigate to Sessions
  await page.evaluate(() => document.querySelector('[data-view="sessions"]').click());
  await sleep(2500);

  // 5. Click into first session
  await page.evaluate(() => document.querySelector('.session-item').click());
  await sleep(3000);

  // 6. Scroll down to see events
  await page.evaluate(() => window.scrollBy(0, 400));
  await sleep(2000);
  await page.evaluate(() => window.scrollBy(0, 400));
  await sleep(2000);

  // 7. Go back and navigate to Timeline
  await page.evaluate(() => document.querySelector('[data-view="timeline"]').click());
  await sleep(2500);

  // 8. Scroll timeline
  await page.evaluate(() => window.scrollBy(0, 300));
  await sleep(2000);

  // 9. Navigate to Files
  await page.evaluate(() => document.querySelector('[data-view="files"]').click());
  await sleep(2000);

  // 10. Toggle off group by directory to show flat list
  await page.evaluate(() => document.getElementById('groupToggle').click());
  await sleep(2500);

  // 11. Navigate to Stats
  await page.evaluate(() => document.querySelector('[data-view="stats"]').click());
  await sleep(2500);

  // 12. Back to Search for closing shot
  await page.evaluate(() => document.querySelector('[data-view="search"]').click());
  await sleep(2000);

  await recorder.stop();
  console.log(`🎬 Recording saved to ${OUT}`);

  await browser.close();
}

run().catch(err => { console.error(err); process.exit(1); });
