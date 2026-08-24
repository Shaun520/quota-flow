import { chromium } from 'playwright-core';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pages = [
  { name: 'index', path: '/' },
  { name: 'landing', path: '/web-landing.html' },
  { name: 'download', path: '/web-download.html' },
  { name: 'pricing', path: '/web-pricing.html' },
  { name: 'docs', path: '/web-docs.html' },
  { name: 'register', path: '/web-register.html' },
];

const baseUrl = 'http://localhost:8080';
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

for (const page of pages) {
  const p = await context.newPage();
  await p.goto(`${baseUrl}${page.path}`, { waitUntil: 'networkidle' });
  // wait for fonts and layout
  await p.waitForTimeout(1500);
  const screenshotPath = join(__dirname, `${page.name}.png`);
  await p.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Saved ${screenshotPath}`);
  await p.close();
}

await browser.close();
