const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const { createCalendarWebhookHandler } = require('./lib/bitrix-calendar-webhook');
const { createEventHandler } = require('./lib/bitrix-event-api');
const { createSpravkaHandler, authorized } = require('./lib/bitrix-spravka');
const { createBitrixSpravkaApp, sessionCors } = require('./lib/bitrix-spravka-app');
require('dotenv').config();

const app = express();
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        "https://*.bitrix24.ru",
        "https://*.bitrix24.com",
        "https://cdn-ru.bitrix24.ru",
        "https://cdn.bitrix24.ru",
        "https://cdn.bitrix24.com",
        "https://*.crmform.bitrix24.ru",
        "https://*.crmform.bitrix24.com"
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https:", "data:"],
      imgSrc: ["'self'", "data:", "https://*.bitrix24.ru", "https://*.bitrix24.com"],
      connectSrc: [
        "'self'",
        "https://*.bitrix24.ru",
        "https://*.bitrix24.com",
        "https://cdn-ru.bitrix24.ru",
        "https://cdn.bitrix24.ru",
        "https://cdn.bitrix24.com",
        "https://*.crmform.bitrix24.ru",
        "https://*.crmform.bitrix24.com",
        "wss:",
        "ws:"
      ],
      fontSrc: ["'self'", "data:", "https:"] ,
      frameSrc: [
        "'self'",
        "https://*.bitrix24.ru",
        "https://*.bitrix24.com",
        "https://*.crmform.bitrix24.ru",
        "https://*.crmform.bitrix24.com"
      ],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: [
        "'self'",
        "https://*.bitrix24.ru",
        "https://*.bitrix24.com",
        "https://*.crmform.bitrix24.ru",
        "https://*.crmform.bitrix24.com"
      ],
      upgradeInsecureRequests: []
    }
  }
}));
app.use(express.json({ limit: '64kb' }));

const PORT = process.env.PORT || 3000;

const allowedEnv = process.env.ALLOWED_ORIGINS || '';
const allowed = allowedEnv.split(',').map(s => s.trim()).filter(Boolean);
console.log('[PROXY] Allowed origins:', allowed.length ? allowed : ['*']);
if (!process.env.BITRIX_WEBHOOK && !process.env.B24_WEBHOOK_URL) {
  console.warn('[PROXY] WARNING: BITRIX_WEBHOOK/B24_WEBHOOK_URL is not set. /api/lead will fail.');
}
if (!process.env.B24_WEBHOOK_URL && !process.env.BITRIX_WEBHOOK) {
  console.warn('[PROXY] WARNING: B24_WEBHOOK_URL is not set. /api/event/:id lookup may fail.');
}
const corsMiddleware = cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true); // allow non-browser tools and same-origin file access
    if (allowed.length === 0) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  optionsSuccessStatus: 200
});
// Session entry/logout use explicit credentials, not ambient cookies.
// The unrelated lead-form allowlist must not prevent entry or session revocation.
app.use(sessionCors(corsMiddleware));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

// The root is also the source checkout: never serve server code or deployment files.
app.use((req, res, next) => {
  // express.static decodes and normalizes URLs. Apply the same interpretation
  // before denying source/private pages, including %2e and encoded directories.
  let pathname;
  try { pathname = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, '/')).toLowerCase(); }
  catch { return res.sendStatus(404); }
  if (/^\/(?:lib|deploy|scripts|test|node_modules|\.git|spravka-admin\.html)(?:\/|$)/.test(pathname) ||
      /\.(?:env|md|json|js|ya?ml|conf|service|lock)$/.test(pathname)) {
    return res.sendStatus(404);
  }
  next();
});
app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));

app.get('/health', (req, res) => res.json({ ok: true }));

function getLeadWebhookUrl() {
  const raw = ((process.env.BITRIX_WEBHOOK || process.env.B24_WEBHOOK_URL) || '').trim();
  if (!raw) return '';

  const cleaned = raw.replace(/\/+$/, '');

  if (/\/crm\.lead\.add(?:\.json)?$/i.test(cleaned)) {
    return cleaned.replace(/(?:\.json)?$/i, '.json');
  }

  if (/\/[A-Za-z0-9_.-]+\.json$/i.test(cleaned)) {
    return cleaned.replace(/\/[A-Za-z0-9_.-]+\.json$/i, '/crm.lead.add.json');
  }

  return `${cleaned}/crm.lead.add.json`;
}

app.get('/api/event/:id', createEventHandler());
app.get('/api/loader', require('./api/loader'));
const bitrixSpravkaApp = createBitrixSpravkaApp();
// One shared report/cache; Basic is checked first and never depends on OAuth availability.
app.all('/api/spravka', createSpravkaHandler({
  authorize: (req, env, context) => authorized(req, env) || bitrixSpravkaApp.authorize(req, context),
  revalidate: (req, env) => authorized(req, env) || bitrixSpravkaApp.revalidate(req),
  cacheTtl: bitrixSpravkaApp.cacheTtl
}));
app.post('/spravka/bitrix', express.urlencoded({ extended: false, limit: '32kb' }), bitrixSpravkaApp.entry);
app.get('/spravka/bitrix', (req, res) => res.redirect(303, '/spravka'));
app.post('/api/spravka/bitrix/logout', bitrixSpravkaApp.logout);
app.all('/api/spravka/bitrix/admin/:action', bitrixSpravkaApp.admin);
app.post('/spravka/bitrix/report', express.urlencoded({ extended: false, limit: '4kb' }), bitrixSpravkaApp.openReport);
app.get(['/spravka', '/spravka/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'spravka.html'));
});

// Serve friendly route for event-register
app.get(['/event-register', '/event-register/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'event-register.html'));
});

app.post('/api/lead', async (req, res) => {
  const url = getLeadWebhookUrl();
  if (!url) return res.status(500).json({ error: 'webhook missing' });

  const fields = req.body && req.body.fields;
  if (!fields) return res.status(400).json({ error: 'missing fields' });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    const data = await resp.json();
    return res.json(data);
  } catch (e) {
    console.error('[PROXY] Error forwarding to Bitrix:', e);
    return res.status(502).json({ error: e.message });
  }
});

app.post('/api/calendar-webhook', createCalendarWebhookHandler());

app.use((err, req, res, next) => {
  if (req.path.startsWith('/spravka/bitrix') || req.path.startsWith('/api/spravka/bitrix/')) {
    // Body-parser errors can include a fragment of the credential-bearing body.
    return res.status(err.status === 413 ? 413 : 400).json({ error: 'Не удалось обработать запрос приложения.' });
  }
  console.error(err && err.message);
  res.status(500).json({ error: err && err.message });
});

app.listen(PORT, () => console.log(`Proxy server listening on ${PORT}`));
