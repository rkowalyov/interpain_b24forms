# interpain_b24forms
Универсальные CRM формы для interpain.botrix24.ru

## Event register page

A simple external registration page is available at `/event-register` and expects the query param `EVNUMBER`.

Example URL:

	https://your-domain.ru/event-register/?EVNUMBER=845

Configuration options (optional):

- `window.B24_LOADER_URL` — override Bitrix24 loader script URL if needed (default loader URL is used otherwise).
- `window.EVENT_API_BASE` — base URL used to fetch event data; default is `/api/event`. The page requests `EVENT_API_BASE/{EVNUMBER}` and expects JSON `{ name, date, city }`.

The page will set hidden form properties on `b24:form:init` using `form.setProperty`: `EVNUMBER`, `EVENT_NAME`, `EVENT_DATE`, `EVENT_CITY`.

## Troubleshooting: EVNUMBER parameter arrives as 0

If the `EVNUMBER` parameter is being transmitted but arrives in Bitrix as **0**, it's likely due to the field type configuration.

### Solution:

1. Open Bitrix24 Admin: `https://your-domain.bitrix24.ru/admin/`
2. Navigate to: **CRM** → **Channels** → **Forms**
3. Edit your form and find the **EVNUMBER** field
4. **Change field type** from **"Integer"** to **"Text"** (Целое число → Текст)
5. Save changes

The parameter should now be transmitted correctly and arrive as `845` instead of `0`.

### Additional debugging:

See [EVNUMBER_TRANSMISSION_STATUS.md](EVNUMBER_TRANSMISSION_STATUS.md) for detailed transmission flow and debugging steps.

