# interpain_b24forms
Универсальные CRM формы для interpain.botrix24.ru

## Event register page

A simple external registration page is available at `/event-register` and expects the query param `EVPASSPORT_ID`.

Example URL:

	https://your-domain.ru/event-register/?EVPASSPORT_ID=845

Configuration options (optional):

- `window.B24_LOADER_URL` — override Bitrix24 loader script URL if needed (default loader URL is used otherwise).
- `window.EVENT_API_BASE` — base URL used to fetch event data; default is `/api/event`. The page requests `EVENT_API_BASE/{EVPASSPORT_ID}` and expects JSON `{ name, date, city }`.

The page will set hidden form properties on `b24:form:init` using `form.setProperty`: `EVPASSPORT_ID`, `EVENT_NAME`, `EVENT_DATE`, `EVENT_CITY`.

