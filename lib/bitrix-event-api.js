const EVENT_ENTITY_TYPE_ID = Number(process.env.EVENT_ENTITY_TYPE_ID || 1036);
const EVENT_STATE_FIELD = process.env.EVENT_STATE_FIELD || 'ufCrm21EventState';
const EVENT_STATE_CODE_FIELD = process.env.EVENT_STATE_CODE_FIELD || 'ufCrm21_1739459683';
const EVENT_OPEN_STATE_ID = Number(process.env.EVENT_OPEN_STATE_ID || 1111);
const EVENT_TIME_ZONE = process.env.EVENT_TIME_ZONE || 'Europe/Moscow';

function normalizeWebhookBase(raw) {
  const cleaned = String(raw || '').trim();
  if (!cleaned) return '';

  try {
    const parsed = new URL(cleaned);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const restIndex = parts.lastIndexOf('rest');

    if (restIndex >= 0 && parts.length >= restIndex + 3) {
      parsed.pathname = `/${parts.slice(0, restIndex + 3).join('/')}`;
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/+$/, '');
    }

    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return cleaned.replace(/\/+$/, '');
  }
}

function getWebhookBase() {
  const b24 = process.env.B24_WEBHOOK_URL && process.env.B24_WEBHOOK_URL.trim();
  if (b24) return normalizeWebhookBase(b24);

  const leadWebhook = process.env.BITRIX_WEBHOOK && process.env.BITRIX_WEBHOOK.trim();
  return leadWebhook ? normalizeWebhookBase(leadWebhook) : '';
}

async function b24Call(base, method, params = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, String(item));
    } else if (value !== undefined && value !== null) {
      body.append(key, String(value));
    }
  }

  const timeoutMs = Number(process.env.EVENT_API_TIMEOUT_MS) || 6000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      const error = new Error(data.error_description || data.error || `HTTP ${response.status}`);
      error.code = data.error;
      throw error;
    }

    return data.result;
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Bitrix CRM request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'UPSTREAM_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseDateSafe(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatEventDateRange(startValue, endValue) {
  const start = parseDateSafe(startValue);
  const end = parseDateSafe(endValue);
  if (!start && !end) return '';

  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: EVENT_TIME_ZONE
  });
  const formatParts = (date) => {
    const parts = dateFormatter.formatToParts(date);
    return {
      day: parts.find((part) => part.type === 'day')?.value || '',
      month: parts.find((part) => part.type === 'month')?.value || '',
      year: parts.find((part) => part.type === 'year')?.value || ''
    };
  };

  if (start && end) {
    const startParts = formatParts(start);
    const endParts = formatParts(end);
    if (startParts.year === endParts.year) {
      return `${startParts.day} ${startParts.month} - ${endParts.day} ${endParts.month} ${startParts.year} года`;
    }
    return `${startParts.day} ${startParts.month} ${startParts.year} года - ${endParts.day} ${endParts.month} ${endParts.year} года`;
  }

  const single = formatParts(start || end);
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
    if (/^г$/i.test(beforeDot) && afterDot) candidate = afterDot;
    else if (beforeDot) candidate = beforeDot;
  }

  return candidate
    .replace(/\b(ул|улица|проспект|пр-т|переулок|пер|наб|набережная)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEventPayload(item, id) {
  const stateId = Number(item?.[EVENT_STATE_FIELD]);
  const stateCode = String(item?.[EVENT_STATE_CODE_FIELD] || '').toUpperCase();
  const registrationOpen = stateId === EVENT_OPEN_STATE_ID || stateCode === 'OPEN';
  const venue = item?.ufCrm21EventAddr || '';

  return {
    id: Number(item?.id || id),
    found: true,
    registrationOpen,
    message: registrationOpen ? null : 'Регистрация сейчас закрыта',
    name: item?.ufCrm21DpoName || item?.title || `Мероприятие №${id}`,
    date: formatEventDateRange(item?.ufCrm21EventDate, item?.ufCrm21EventEndDate),
    city: extractCityFromVenue(venue),
    venue,
    stateId: Number.isFinite(stateId) ? stateId : null,
    stateCode: stateCode || null
  };
}

function createEventHandler() {
  return async function eventHandler(req, res) {
    const query = req.query || require('url').parse(req.url, true).query;
    const id = (req.params && req.params.id) || query.id || query.EVNUMBER || query.EVPASSPORT_ID;
    if (!id) return res.status(400).json({ error: 'Missing event id' });

    const webhookBase = getWebhookBase();
    if (!webhookBase) return res.status(500).json({ error: 'Bitrix webhook is not configured' });

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

      console.error('[api/event] lookup error:', error);
      return res.status(502).json({
        found: false,
        registrationOpen: false,
        error: error && error.message ? error.message : 'Bitrix request failed',
        code: error && error.code ? error.code : 'UPSTREAM_ERROR'
      });
    }
  };
}

module.exports = { b24Call, createEventHandler, getWebhookBase, extractCityFromVenue };
