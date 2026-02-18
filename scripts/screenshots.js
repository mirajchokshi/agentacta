const { execSync } = require('child_process');
const path = require('path');

const CHROME = '/usr/bin/google-chrome-stable';
const BASE = 'http://localhost:4003';
const OUT = path.join(__dirname, '..', 'screenshots');

const views = [
  { name: 'search', nav: null },
  { name: 'sessions', nav: 'sessions' },
  { name: 'timeline', nav: 'timeline' },
  { name: 'files', nav: 'files' },
  { name: 'stats', nav: 'stats' },
];

// We'll use puppeteer-core if available, otherwise a simple approach
async function run() {
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); } catch(e) {
    try { puppeteer = require('puppeteer'); } catch(e2) {
      console.log('Installing puppeteer-core...');
      execSync('npm install puppeteer-core', { cwd: path.join(__dirname, '..') });
      puppeteer = require('puppeteer-core');
    }
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1280,900']
  });

  const mainPage = await browser.newPage();
  await mainPage.setViewport({ width: 1280, height: 900 });
  await mainPage.goto(BASE, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));

  for (const view of views) {
    if (view.nav) {
      await mainPage.evaluate((v) => {
        document.querySelector(`[data-view="${v}"]`).click();
      }, view.nav);
      await new Promise(r => setTimeout(r, 1500));
    }
    await mainPage.screenshot({ path: path.join(OUT, `${view.name}.png`), fullPage: false });
    console.log(`📸 ${view.name}.png`);
  }

  // Session detail - click first session
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE}/#sessions`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1000));
  await page.click('.session-item');
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(OUT, 'session-detail.png'), fullPage: false });
  console.log('📸 session-detail.png');
  await page.close();

  // Search with query
  const searchPage = await browser.newPage();
  await searchPage.setViewport({ width: 1280, height: 900 });
  await searchPage.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 500));
  await searchPage.type('#searchInput', 'docker');
  await new Promise(r => setTimeout(r, 1500));
  await searchPage.screenshot({ path: path.join(OUT, 'search-results.png'), fullPage: false });
  console.log('📸 search-results.png');
  await searchPage.close();

  await browser.close();
  console.log(`\nDone! Screenshots in ${OUT}`);
}

run().catch(err => { console.error(err); process.exit(1); });
