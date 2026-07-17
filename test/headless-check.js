const URL = process.env.URL || 'https://interpain-b24forms.vercel.app/event-register/?EVNUMBER=845';

(async () => {
  try {
    const pp = await import('puppeteer');
    const puppeteer = pp.default || pp;

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
      });
    } catch (launchErr) {
      console.warn('Default Chromium launch failed, trying system Chrome:', launchErr && launchErr.message);
      // Try common macOS Chrome path as fallback
      const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: chromePath,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
      });
    }
    const page = await browser.newPage();

  page.on('console', msg => {
    console.log('PAGE:', msg.text());
  });

  page.on('response', resp => {
    try {
      const status = resp.status();
      if (status >= 400) console.log('RESP', status, resp.url());
    } catch (e) {}
  });

  console.log('Opening', URL);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  let found = false;
  try {
    await page.waitForSelector('script[data-b24-form]', { timeout: 10000 });
    console.log('Found data-b24-form script tag');
    found = true;
  } catch (e) {
    console.log('No data-b24-form script tag found within timeout');
  }

  // If loader script wasn't added by the page, inject it manually
  if (!found) {
    await page.evaluate(() => {
      const loaderBase = 'https://cdn-ru.bitrix24.ru/b16533649/crm/form/loader_739.js';
      const script = document.createElement('script');
      script.async = true;
      script.setAttribute('data-b24-form', 'inline/739/0zko7k');
      script.setAttribute('data-skip-moving', 'true');
      script.src = loaderBase + '?' + ((Date.now() / 180000) | 0);
      const first = document.getElementsByTagName('script')[0];
      if (first && first.parentNode) first.parentNode.insertBefore(script, first);
      else document.getElementById('b24form_container')?.appendChild(script);
    });
    console.log('Injected loader script tag manually');
    // Give the page time to register its handler
    await page.waitForTimeout(3000);
  }

  // Prepare capture array in page
  await page.evaluate(() => {
    window.__setPropertyCalls = window.__setPropertyCalls || [];
  });

  // Add observer that wraps form.setProperty when loader emits b24:form:init
  await page.evaluate(() => {
    window.__setPropertyCalls = window.__setPropertyCalls || [];
    window.__observedInit = false;
    window.addEventListener('b24:form:init', (ev) => {
      window.__observedInit = true;
      console.log('OBSERVED b24:form:init');
      try {
        const detail = ev && ev.detail;
        const form = (detail && (detail[0] || detail.form)) || detail || (window.BX24 && window.BX24.form);
        if (form && typeof form.setProperty === 'function') {
          const orig = form.setProperty.bind(form);
          form.setProperty = function(k, v) {
            window.__setPropertyCalls.push([k, v]);
            console.log('WRAPPED SETPROP', k, String(v));
            try { return orig(k, v); } catch(e) { console.warn('orig.setProperty failed', e); }
          };
        }
      } catch (e) { console.warn('observer error', e); }
    });
  });

  // Wait to see if loader triggers init by itself
  await page.waitForTimeout(3000);
  const observed = await page.evaluate(() => window.__observedInit);
  console.log('Loader emitted b24:form:init by itself?', observed);

  // Dispatch b24:form:init with a mock form that records setProperty calls
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('b24:form:init', {
      detail: [{
        setProperty: (k, v) => {
          window.__setPropertyCalls.push([k, v]);
          console.log('SETPROP', k, String(v));
        }
      }]
    }));
  });

  // Wait briefly for any handlers to run
  await page.waitForTimeout(1500);

  // Dump script tags for debugging
  const scripts = await page.evaluate(() => Array.from(document.scripts).map(s=>({src:s.src, dataset:s.dataset, outer: s.outerHTML.slice(0,200)})));
  console.log('PAGE SCRIPTS:', JSON.stringify(scripts, null, 2));

  const calls = await page.evaluate(() => window.__setPropertyCalls || []);

    console.log('Captured setProperty calls:', JSON.stringify(calls, null, 2));

    await browser.close();
  } catch (err) {
    console.error('Headless test error:', err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
