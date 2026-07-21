const DEFAULT_TIME_ZONE = process.env.EVENT_TIME_ZONE || 'Europe/Moscow';
const DEFAULT_CALENDAR_TYPE = process.env.B24_CALENDAR_TYPE || 'user';
const DEFAULT_CALENDAR_OWNER_ID = Number.parseInt(
  process.env.B24_CALENDAR_OWNER_ID || (DEFAULT_CALENDAR_TYPE === 'company_calendar' ? '0' : '1'),
  10
);
const DEFAULT_CALENDAR_SECTION_NAME = process.env.B24_CALENDAR_SECTION_NAME || 'Планирование УЦ АИЛБ';

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

function normalizeAction(value, hasBitrixEventId) {
  const action = String(value || '').toLowerCase();
  if (action === 'create' || action === 'add') return 'create';
  if (action === 'update' || action === 'edit') return 'update';
  if (action === 'upsert') return hasBitrixEventId ? 'update' : 'create';
  return hasBitrixEventId ? 'update' : 'create';
}

function pickEventPayload(body = {}) {
  return (body && typeof body.event === 'object' && body.event) ? body.event : body;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeDateInput(value) {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const text = String(value).trim();
  return text || undefined;
}

function isDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function normalizeCalendarParams(event, action) {
  const type = pickFirst(event.type, event.calType, event.cal_type, DEFAULT_CALENDAR_TYPE);
  const ownerId = Number(pickFirst(event.ownerId, event.owner_id, event.OWNER_ID, Number.isFinite(DEFAULT_CALENDAR_OWNER_ID) ? DEFAULT_CALENDAR_OWNER_ID : 0));
  const bitrixEventId = pickFirst(event.id, event.eventId, event.event_id, event.calendarEventId, event.calendar_event_id);
  const name = String(pickFirst(event.name, event.title, event.NAME, '') || '').trim();
  const fromRaw = pickFirst(event.from, event.start, event.dateFrom, event.date_from, event.DATE_FROM);
  const toRaw = pickFirst(event.to, event.end, event.dateTo, event.date_to, event.DATE_TO);
  const from = normalizeDateInput(fromRaw);
  const to = normalizeDateInput(toRaw);
  const skipTime = String(pickFirst(event.skip_time, event.skipTime, event.allDay ? 'Y' : '', '') || '').toUpperCase() === 'Y'
    || isDateOnly(fromRaw)
    || isDateOnly(toRaw)
    ? 'Y'
    : 'N';

  const params = {
    type,
    ownerId,
    name,
    skip_time: skipTime,
    timezone_from: pickFirst(event.timezone_from, event.timezoneFrom, event.tzFrom, event.TZ_FROM, DEFAULT_TIME_ZONE),
    timezone_to: pickFirst(event.timezone_to, event.timezoneTo, event.tzTo, event.TZ_TO, DEFAULT_TIME_ZONE)
  };

  if (from) params.from = from;
  if (to) params.to = to;

  const section = pickFirst(event.section, event.sectionId, event.section_id, event.SECTION_ID);
  if (section !== undefined && section !== null && section !== '') {
    params.section = Number(section);
  }
  const sectionName = pickFirst(event.sectionName, event.section_name, event.calendarName, event.calendar_name, event.calendar);
  if (sectionName) {
    params.__sectionName = String(sectionName).trim();
  }

  const description = pickFirst(event.description, event.DESCRIPTION);
  if (description) params.description = String(description);

  const location = pickFirst(event.location, event.LOCATION, event.place, event.PLACE);
  if (location) params.location = String(location);

  const attendees = pickFirst(event.attendees, event.ATTENDEES, event.attendeeIds, event.attendee_ids);
  if (Array.isArray(attendees) && attendees.length) {
    params.attendees = attendees.map((item) => String(item));
  }

  const reminders = pickFirst(event.remind, event.reminders, event.REMIND);
  if (Array.isArray(reminders) && reminders.length) {
    params.remind = reminders;
  }

  if (action === 'update') {
    const id = Number(bitrixEventId);
    if (!Number.isFinite(id) || id <= 0) {
      const error = new Error('Missing calendar event id for update');
      error.code = 'MISSING_EVENT_ID';
      throw error;
    }
    params.id = id;
  }

  return params;
}

async function resolveSectionIdByName(base, params) {
  if (!base || !params || params.section) return params;

  const targetName = String(params.__sectionName || DEFAULT_CALENDAR_SECTION_NAME || '').trim();
  if (!targetName) return params;

  let sections;
  try {
    sections = await b24Call(base, 'calendar.section.get', {
      type: params.type,
      ownerId: params.ownerId
    });
  } catch (error) {
    if (error && error.code === 'insufficient_scope') {
      const scopeError = new Error(
        'Calendar section lookup requires calendar scope. Grant calendar permissions to webhook or pass event.section explicitly.'
      );
      scopeError.code = 'SECTION_SCOPE_MISSING';
      throw scopeError;
    }
    throw error;
  }

  const list = Array.isArray(sections) ? sections : [];
  const found = list.find((item) => String(item?.NAME || '').trim().toLowerCase() === targetName.toLowerCase());

  if (!found || !found.ID) {
    const error = new Error(`Calendar section not found: ${targetName}`);
    error.code = 'SECTION_NOT_FOUND';
    throw error;
  }

  params.section = Number(found.ID);
  if (!Number.isFinite(params.section) || params.section <= 0) {
    const error = new Error(`Invalid calendar section id for: ${targetName}`);
    error.code = 'SECTION_NOT_FOUND';
    throw error;
  }

  return params;
}

function validatePayload(body = {}) {
  const event = pickEventPayload(body);
  const hasBitrixEventId = Boolean(pickFirst(event.id, event.eventId, event.event_id, event.calendarEventId, event.calendar_event_id));
  const action = normalizeAction(pickFirst(body.action, body.operation, body.mode, event.action, event.operation, event.mode), hasBitrixEventId);

  const params = normalizeCalendarParams(event, action);
  return { action, params };
}

function createCalendarWebhookHandler() {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const webhookBase = getWebhookBase();
    if (!webhookBase) {
      return res.status(500).json({ error: 'Bitrix webhook is not configured' });
    }

    try {
      const { action, params } = validatePayload(req.body || {});
      await resolveSectionIdByName(webhookBase, params);
      delete params.__sectionName;
      const method = action === 'update' ? 'calendar.event.update' : 'calendar.event.add';
      const result = await b24Call(webhookBase, method, params);

      return res.status(200).json({
        ok: true,
        action,
        method,
        result
      });
    } catch (error) {
      const status = error && (
        error.code === 'MISSING_EVENT_ID'
        || error.code === 'SECTION_NOT_FOUND'
        || error.code === 'SECTION_SCOPE_MISSING'
      ) ? 400 : 502;
      console.error('[calendar-webhook] error:', error);
      return res.status(status).json({
        ok: false,
        error: error && error.message ? error.message : 'Bitrix request failed'
      });
    }
  };
}

module.exports = {
  createCalendarWebhookHandler,
  validatePayload,
  normalizeCalendarParams,
  normalizeAction,
  resolveSectionIdByName
};