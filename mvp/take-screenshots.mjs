import puppeteer from 'puppeteer-core';

const BASE = 'http://localhost:3001';
const DIR = '/home/user/one-shot/screenshots';

const pages = [
  { name: '01-login', path: '/login', noAuth: true },
  { name: '02-dashboard', path: '/' },
  { name: '03-agent-activity', path: '/agents/agent-1/activity' },
  { name: '04-agent-playground', path: '/agents/agent-1/play' },
  { name: '05-agent-flow', path: '/agents/agent-1/flow' },
  { name: '06-agent-tests', path: '/agents/agent-1/tests' },
  { name: '07-agent-knowledge', path: '/agents/agent-1/knowledge' },
  { name: '08-agent-voice', path: '/agents/agent-1/voice' },
  { name: '09-agent-integrations', path: '/agents/agent-1/integrations' },
  { name: '10-agent-channels', path: '/agents/agent-1/channels' },
  { name: '11-agent-insights', path: '/agents/agent-1/insights' },
  { name: '12-agent-settings', path: '/agents/agent-1/settings' },
  { name: '13-settings', path: '/settings' },
  { name: '14-onboarding', path: '/onboarding', noAuth: true },
  { name: '15-agent-builder', path: '/agents/new' },
];

async function run() {
  const browser = await puppeteer.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Bypass auth
  await page.evaluateOnNewDocument(() => {
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('/auth/me')) {
        return new Response(JSON.stringify({
          user_id: 'user-1',
          email: 'sarah@sarahsflowers.com',
          name: 'Sarah Johnson',
          org_id: 'org-1',
          onboarding_complete: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return origFetch(url, opts);
    };
  });

  // No-auth pages first
  for (const p of pages.filter(p => p.noAuth)) {
    await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: `${DIR}/${p.name}.png`, fullPage: p.name !== '01-login' });
    console.log(`✓ ${p.name}`);
  }

  // Set token for auth pages
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    localStorage.setItem('agentos_token', 'mock-token-for-screenshots');
  });

  for (const p of pages.filter(p => !p.noAuth)) {
    await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: `${DIR}/${p.name}.png`, fullPage: true });
    console.log(`✓ ${p.name}`);
  }

  await browser.close();
  console.log(`\nDone! ${pages.length} screenshots saved to ${DIR}`);
}

run().catch(console.error);
