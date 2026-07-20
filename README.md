# interpain_b24forms

Универсальные CRM формы для interpain.botrix24.ru

## Event register page

A simple external registration page is available at `/event-register` and expects the query param `EVNUMBER`.

Example URL:

  [https://your-domain.ru/event-register/?EVNUMBER=845](https://your-domain.ru/event-register/?EVNUMBER=845)

Configuration options (optional):

- `window.B24_LOADER_URL` — override Bitrix24 loader script URL if needed (default loader URL is used otherwise).
- `window.EVENT_API_BASE` — base URL used to fetch event data; default is `/api/event`. The page requests `EVENT_API_BASE/{EVNUMBER}` and expects JSON `{ name, date, city }`.
- `B24_DEFAULT_FORM_ID` (Vercel env var) — default CRM form ID used by `/api/loader` when `CRMFNUMBER` is missing/invalid/unavailable. Default value is `739`.

The page will set hidden form properties on `b24:form:init` using `form.setProperty`: `EVNUMBER`, `EVENT_NAME`, `EVENT_DATE`, `EVENT_CITY`.

## Bitrix24 calendar webhook

The repository also includes a webhook handler for creating and updating Bitrix24 calendar events:

- `POST /api/calendar-webhook`

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

