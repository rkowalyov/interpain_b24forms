const EVENT_ENTITY_TYPE_ID = Number(process.env.EVENT_ENTITY_TYPE_ID || 1036);
const EVENT_STATE_FIELD = process.env.EVENT_STATE_FIELD || 'ufCrm21EventState';
const EVENT_STATE_CODE_FIELD = process.env.EVENT_STATE_CODE_FIELD || 'ufCrm21_1739459683';
const EVENT_OPEN_STATE_ID = Number(process.env.EVENT_OPEN_STATE_ID || 1111);

function getWebhookBase() {
  const b24 = process.env.B24_WEBHOOK_URL && process.env.B24_WEBHOOK_URL.trim();
  if (b24) return b24.replace(/\/+$/, '');

  const leadWebhook = process.env.BITRIX_WEBHOOK && process.env.BITRIX_WEBHOOK.trim();
  if (!leadWebhook) return '';

  return leadWebhook
    .replace(/\/+$/, '')
    .replace(/\/[A-Za-z0-9_.-]+(?:\.json)?$/, '');
}

function methodUrl(base, method) {
  return `${base}/${method}.json`;
}

async function b24Call(base, method, params = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, String(item));
      continue;
    }
    if (value !== undefined && value !== null) {
      body.append(key, String(value));
    }
  }

  const response = await fetch(methodUrl(base, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error(data.error_description || data.error || `HTTP ${response.status}`);
    error.code = data.error;
    throw error;
  }

  return data.result;
}

function parseDateSafe(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatEventDateRange(startValue, endValue) {
  const start = parseDateSafe(startValue);
  const end = parseDateSafe(endValue);

  if (!start && !end) return '';

  const monthNames = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
  ];
  const fmt = (dt) => ({
    day: dt.toLocaleDateString('ru-RU', { day: 'numeric' }),
    month: monthNames[dt.getMonth()],
    year: dt.toLocaleDateString('ru-RU', { year: 'numeric' })
  });

  if (start && end) {
    const s = fmt(start);
    const e = fmt(end);
    if (s.year === e.year) {
      return `${s.day} ${s.month} - ${e.day} ${e.month} ${s.year} года`;
    }
    return `${s.day} ${s.month} ${s.year} года - ${e.day} ${e.month} ${e.year} года`;
  }

  const single = fmt(start || end);
  return `${single.day} ${single.month} ${single.year} года`;
}

function extractCityFromVenue(venue) {
  if (!venue) return '';

  let candidate = String(venue).split(',')[0].trim();
  candidate = candidate.replace(/^г\.\s*/i, '').replace(/^город\s+/i, '').trim();

  if (candidate.includes('.')) {
    const dot = candidate.indexOf('.');
    const beforeDot = candidate.slice(0, dot).trim();
    const afterDot = candidate.slice(dot + 1).trim();
    if (/^г$/i.test(beforeDot) && afterDot) {
      candidate = afterDot;
    } else if (beforeDot) {
      candidate = beforeDot;
    }
  }

  candidate = candidate
    .replace(/\b(ул|улица|проспект|пр-т|переулок|пер|наб|набережная)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return candidate;
}

function normalizeEventPayload(item, id) {
  const rawStateId = item?.[EVENT_STATE_FIELD];
  const stateId = Number(rawStateId);
  const stateCode = String(item?.[EVENT_STATE_CODE_FIELD] || '').toUpperCase();
  const registrationOpen = stateId === EVENT_OPEN_STATE_ID || stateCode === 'OPEN';
  const venue = item?.ufCrm21EventAddr || '';
  const dateRange = formatEventDateRange(item?.ufCrm21EventDate, item?.ufCrm21EventEndDate);

  return {
    id: Number(item?.id || id),
    found: true,
    registrationOpen,
    message: registrationOpen ? null : 'Регистрация сейчас закрыта',
    name: item?.ufCrm21DpoName || item?.title || `Мероприятие №${id}`,
    date: dateRange,
    city: extractCityFromVenue(venue),
    venue,
    stateId: Number.isFinite(stateId) ? stateId : null,
    stateCode: stateCode || null
  };
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing event id' });
  }

  const webhookBase = getWebhookBase();
  if (!webhookBase) {
    return res.status(500).json({ error: 'Bitrix webhook is not configured' });
  }

  try {
    const result = await b24Call(webhookBase, 'crm.item.get', {
      entityTypeId: EVENT_ENTITY_TYPE_ID,
      id
    });
    const item = result && result.item ? result.item : result;

    if (!item || typeof item !== 'object') {
      return res.status(404).json({
        found: false,
        registrationOpen: false,
        message: 'Мероприятие не найдено'
      });
    }

    return res.status(200).json(normalizeEventPayload(item, id));
  } catch (error) {
    if (error && error.code === 'NOT_FOUND') {
      return res.status(404).json({
        found: false,
        registrationOpen: false,
        message: 'Мероприятие не найдено'
      });
    }

    console.error('[api/event/:id] lookup error:', error);
    return res.status(502).json({
      found: false,
      registrationOpen: false,
      error: error && error.message ? error.message : 'Bitrix request failed'
    });
  }
}
