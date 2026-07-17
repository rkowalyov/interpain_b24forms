# Testing Guide: EVPASSPORT_ID Parameter Transmission

## How to Verify Parameters Are Being Sent to Bitrix

### Method 1: Browser Console Logs
1. Open https://interpain-b24forms.vercel.app/event-register/?EVPASSPORT_ID=845
2. Press `F12` to open Developer Tools
3. Go to **Console** tab
4. Fill out Step 1 of the form (Фамилия, Имя, Телефон, E-mail)
5. Click "Далее" button
6. **Check the console for these log messages:**
   - `"Intercepted Bitrix fetch POST: https://..."`
   - `"Added params to FormData"` or `"Added params to body"`
   - `"EVPASSPORT_ID added to request"`

### Method 2: Network Tab Inspection
1. Open DevTools (`F12`)
2. Go to **Network** tab
3. Filter by "Fetch/XHR" requests
4. Fill form and click "Далее"
5. Look for POST requests to `*.bitrix24.ru` or `crmform.bitrix24.ru`
6. **Click on the request and check the "Payload" or "Request" section**
7. You should see these parameters in the form data:
   - `EVPASSPORT_ID=845`
   - `EVENT_NAME=Конференция InterPain 2026`
   - `EVENT_DATE=2026-09-15`
   - `EVENT_CITY=Москва`

### Method 3: URL Parameters (Alternative)
The form also passes `EVPASSPORT_ID` via URL parameter:
- Query string: `?EVPASSPORT_ID=845`
- This is visible in the address bar and can be captured by backend

## Current Implementation

### What We're Doing:
1. **AJAX Interception**: We intercept all `fetch()` and `XMLHttpRequest` POST requests
2. **Parameter Injection**: When Bitrix form submits data, we add custom parameters to the payload
3. **Fallback Methods**:
   - Hidden form fields (in DOM but may not be included by Bitrix)
   - `form.setProperty()` calls (attempted but Bitrix may not support custom fields)
   - Window object `B24_FORM_PARAMS` (available for Bitrix to read)
   - Script data attributes (passed but may not be read by Bitrix)

### Parameters Being Passed:
- **EVPASSPORT_ID**: From URL parameter (e.g., 845)
- **EVENT_NAME**: From API endpoint /api/event/{id}
- **EVENT_DATE**: ISO format from event data
- **EVENT_CITY**: From event data

## Expected Behavior

After clicking "Далее" (Step 1 → Step 2):
1. Step 1 data should be submitted to Bitrix
2. Our interceptor should add EVPASSPORT_ID and other custom params
3. The form should transition to Step 2

After clicking "Отправить данные" (final submission):
1. The complete form including all custom parameters should be sent to Bitrix
2. Bitrix CRM should receive and process the data

## Troubleshooting

### Parameters Not Showing in Network Requests?
1. Bitrix might be using a different method (iframe, postMessage, etc.)
2. Check if request is cross-origin (CORS might strip headers)
3. Some parameters might be processed client-side by Bitrix before sending

### Still Getting 0 or Empty Value in Bitrix?
1. Bitrix form might not have a field for custom parameter "EVPASSPORT_ID"
2. The custom field might need different naming (check Bitrix form schema)
3. Bitrix CRM backend might require specific field mapping configuration

## Next Steps

If parameters are confirmed being sent but still not appearing in Bitrix:
1. Contact Bitrix support to confirm custom field compatibility
2. Check if field names need to be mapped in Bitrix admin
3. Verify Bitrix form configuration for accepting custom parameters
4. Consider if parameters need to be pre-filled in Bitrix form settings instead of via URL

## Files Modified

- `event-register.html`: Main form page with parameter passing logic
- `api/loader.js`: Proxy endpoint for Bitrix loader (bypasses ad blockers)
- `api/event/[id].js`: Event data API endpoint
