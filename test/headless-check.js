const URL = process.env.URL || 'https://interpain-b24forms.vercel.app/event-register/?EVNUMBER=845';

(async () => {
  const pp = await import('puppeteer');
  const puppeteer = pp.default || pp;
  const launchOptions = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  };
  let browser;
  try {
    browser = await puppeteer.launch(launchOptions);
  } catch (launchError) {
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (!require('node:fs').existsSync(chromePath)) throw launchError;
    console.warn('Bundled Chromium failed; retrying with system Chrome:', launchError.message);
    browser = await puppeteer.launch({ ...launchOptions, executablePath: chromePath });
  }

  try {
    const page = await browser.newPage();
    page.on('console', (message) => console.log('PAGE:', message.text()));
    page.on('response', (response) => {
      if (response.status() >= 400) console.log('RESP', response.status(), response.url());
    });

    if (process.env.EVENT_API_FIXTURE === '1') {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/event/')) {
          return request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: 845,
              found: true,
              registrationOpen: true,
              name: 'Headless test event',
              date: '',
              city: 'Москва',
              venue: ''
            })
          });
        }
        return request.continue();
      });
    }

    console.log('Opening', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => {
      const container = document.getElementById('b24form_container');
      const status = document.getElementById('event-status');
      const retry = document.getElementById('event-status-retry');
      const formReady = container && container.classList.contains('is-ready');
      const retryVisible = status && getComputedStyle(status).display !== 'none'
        && retry && getComputedStyle(retry).display !== 'none';
      return formReady || retryVisible;
    }, { timeout: 45000 });

    const result = await page.evaluate(() => ({
      formReady: document.getElementById('b24form_container').classList.contains('is-ready'),
      statusTitle: document.getElementById('event-status-title').textContent,
      retryVisible: getComputedStyle(document.getElementById('event-status-retry')).display !== 'none',
      spinnerVisible: getComputedStyle(document.getElementById('loading-form')).display !== 'none'
        && !document.getElementById('loading-form').classList.contains('is-hidden')
    }));

    if (result.spinnerVisible) {
      throw new Error('Registration page stayed on the loading spinner');
    }
    if (!result.formReady && !result.retryVisible) {
      throw new Error('Neither the Bitrix form nor a retryable error was displayed');
    }

    console.log('Registration page reached a terminal state:', JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error('Headless check failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});