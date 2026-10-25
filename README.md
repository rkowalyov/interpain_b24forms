# interpain_b24forms

Универсальные CRM формы для interpain.botrix24.ru

## Справка по мероприятиям

Страница `/spravka/` показывает количество связанных сделок по мероприятиям
в стадии «Реализация». Использует существующий серверный вебхук и отдельный пароль
`SPRAVKA_PASSWORD`. Полная настройка, правила подсчёта и проверка:
[SPRAVKA_SETUP.md](SPRAVKA_SETUP.md).

## Event register page

A simple external registration page is available at `/event-register` and expects the query param `EVNUMBER`.

Example URL:

  [https://your-domain.ru/event-register/?EVNUMBER=845](https://your-domain.ru/event-register/?EVNUMBER=845)

Configuration options (optional):

- `window.B24_LOADER_URL` — override Bitrix24 loader script URL if needed (default loader URL is used otherwise).
- `window.EVENT_API_BASE` — base URL used to fetch event data; default is `/api/event`. The page requests `EVENT_API_BASE/{EVNUMBER}` and expects JSON `{ name, date, city }`.
- `EVENT_API_TIMEOUT_MS` — server-side timeout for Bitrix event lookups in milliseconds; defaults to `6000`. The registration page stops waiting for event data after 8 seconds. On a timeout or server/network error it opens the form without event metadata; an explicit missing event or closed registration still blocks the form.
- `B24_LOADER_CDN_TIMEOUT_MS` / `B24_LOADER_TOTAL_TIMEOUT_MS` — per-provider and total Vercel loader-proxy timeouts in milliseconds; default to `1800` and `7000`.
- `B24_DEFAULT_FORM_ID` (Vercel env var) — default CRM form ID used by `/api/loader` when `CRMFNUMBER` is missing/invalid/unavailable. Default value is `739`.

Loader modes for A/B testing:

- no `mode` parameter — load the inline Bitrix form using the official Bitrix embed code; the browser loads the loader script directly from the Bitrix CDN.
- `mode=old` — use the previous implementation, loading the Bitrix form through the Vercel `/api/loader` proxy.

If the selected loader does not initialize the form, the page tries the other transport (direct Bitrix CDN or the same-origin loader proxy) and then shows a retry action instead of leaving the loading state visible. The local Express server exposes the same `/api/loader` proxy route as Vercel.

Examples: `/event-register/?EVNUMBER=845&CRMFNUMBER=739` uses the new default mode; `/event-register/?EVNUMBER=845&CRMFNUMBER=739&mode=old` uses the previous proxy mode. The form code is resolved from loader metadata unless `CRMFHASH` or `CRMFCODE` is supplied explicitly.

The page will set hidden form properties on `b24:form:init` using `form.setProperty`: `EVNUMBER`, `EVENT_NAME`, `EVENT_DATE`, `EVENT_CITY`.

## Bitrix24 calendar webhook

The repository also includes a webhook handler for creating and updating Bitrix24 calendar events:

- `POST /api/calendar-webhook`

Default target calendar:

- section name: `Планирование УЦ АИЛБ`
- calendar type: `user`
- ownerId: `1`

The handler auto-resolves section id by section name if `section` is not provided.

Request body shape:

    {
      "action": "create",
      "event": {
        "type": "user",
        "ownerId": 1,
        "name": "My event",
        "from": "2026-08-15T10:00:00+03:00",
        "to": "2026-08-15T12:00:00+03:00",
        "timezone_from": "Europe/Moscow",
        "timezone_to": "Europe/Moscow",
        "section": 12,
        "description": "Optional description",
        "location": "Moscow"
      }
    }

For updates, send `action: "update"` and include the Bitrix calendar event id as `event.id` (or `event.calendarEventId`). If `action` is omitted, the handler uses `update` when an event id is present, otherwise `create`.

Override options:

- per request: `event.section`, or `event.sectionName` / `event.calendarName`
- env vars: `B24_CALENDAR_SECTION_NAME`, `B24_CALENDAR_TYPE`, `B24_CALENDAR_OWNER_ID`

Important: auto-resolution by section name uses `calendar.section.get` and requires webhook permissions for calendar scope. If your webhook has limited scope, pass `event.section` explicitly.

## Troubleshooting: EVNUMBER parameter arrives as 0

If the `EVNUMBER` parameter is being transmitted but arrives in Bitrix as **0**, there are two solutions:

### ✅ Solution 1: Business Process (Recommended)

Create a **Business Process** in Bitrix24 that:

1. Reads value from a helper field
2. Converts to number format
3. Assigns to the EVNUMBER field

**Benefits:**

- ✅ No field type changes needed
- ✅ Automatic processing
- ✅ Full control over formatting
- ✅ Scalable for other parameters

See [BITRIX_AUTOMATION_SOLUTION.md](BITRIX_AUTOMATION_SOLUTION.md) for detailed setup.

### ✅ Solution 2: Change Field Type

If you prefer not to use a Business Process:

1. Open Bitrix24 Admin: `https://your-domain.bitrix24.ru/admin/`
2. Navigate to: **CRM** → **Channels** → **Forms**
3. Edit your form and find the **EVNUMBER** field
4. **Change field type** from **"Integer"** to **"Text"** (Целое число → Текст)
5. Save changes

### Additional debugging

See [EVNUMBER_TRANSMISSION_STATUS.md](EVNUMBER_TRANSMISSION_STATUS.md) for detailed transmission flow and debugging steps.
