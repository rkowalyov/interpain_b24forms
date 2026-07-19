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

function normalizeEventPayload(item, id) {
  const rawStateId = item?.[EVENT_STATE_FIELD];
  const stateId = Number(rawStateId);
  const stateCode = String(item?.[EVENT_STATE_CODE_FIELD] || '').toUpperCase();
  const registrationOpen = stateId === EVENT_OPEN_STATE_ID || stateCode === 'OPEN';

  return {
    id: Number(item?.id || id),
    found: true,
    registrationOpen,
    message: registrationOpen ? null : 'Регистрация сейчас закрыта',
    name: item?.title || `Мероприятие №${id}`,
    date: item?.ufCrm21EventDate || '',
    city: item?.ufCrm21EventAddr || '',
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
