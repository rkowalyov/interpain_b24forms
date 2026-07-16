const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(helmet());
app.use(express.json({ limit: '64kb' }));

const PORT = process.env.PORT || 3000;

const allowedEnv = process.env.ALLOWED_ORIGINS || '';
const allowed = allowedEnv.split(',').map(s => s.trim()).filter(Boolean);
console.log('[PROXY] Allowed origins:', allowed.length ? allowed : ['*']);
if (!process.env.BITRIX_WEBHOOK) {
  console.warn('[PROXY] WARNING: BITRIX_WEBHOOK is not set. /api/lead will fail.');
}
app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true); // allow non-browser tools and same-origin file access
    if (allowed.length === 0) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  optionsSuccessStatus: 200
}));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(limiter);

app.use(express.static(path.join(__dirname)));

app.get('/health', (req, res) => res.json({ ok: true }));

// Mock endpoint for event data (used for local testing)
app.get('/api/event/:id', (req, res) => {
  const id = req.params.id;
  // Simple mock data — replace with real API integration as needed
  const sample = {
    '845': { name: 'Конференция InterPain 2026', date: '2026-09-15', city: 'Москва' }
  };
  const payload = sample[id] || { name: `Мероприятие №${id}`, date: '', city: '' };
  res.json(payload);
});

app.post('/api/lead', async (req, res) => {
  const webhook = process.env.BITRIX_WEBHOOK;
  if (!webhook) return res.status(500).json({ error: 'webhook missing' });

  const fields = req.body && req.body.fields;
  if (!fields) return res.status(400).json({ error: 'missing fields' });

  const url = webhook.replace(/\/+$/, '').replace(/\.json$/, '') + '.json';

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

app.use((err, req, res, next) => {
  console.error(err && err.message);
  res.status(500).json({ error: err && err.message });
});

app.listen(PORT, () => console.log(`Proxy server listening on ${PORT}`));
