// Proxy Bitrix loader to bypass client-side content blockers
// Returns fetched JS from Bitrix CDN with conservative cache headers
module.exports = async (req, res) => {
  const envDefaultFormId = Number.parseInt(
    process.env.B24_DEFAULT_FORM_ID || process.env.DEFAULT_CRM_FORM_ID || '',
    10
  );
  const DEFAULT_FORM_ID = Number.isInteger(envDefaultFormId) && envDefaultFormId > 0
    ? envDefaultFormId
    : 739;
  const rawFormId = req.query.formId || req.query.CRMFNUMBER;
  const metaOnly = String(req.query.meta || '') === '1';
  const parsedFormId = Number.parseInt(rawFormId, 10);
  const formId = Number.isInteger(parsedFormId) && parsedFormId > 0 ? parsedFormId : DEFAULT_FORM_ID;
  const ts = req.query.ts || Date.now();
  const accountId = process.env.B24_CDN_ACCOUNT_ID || process.env.BITRIX_ACCOUNT_ID || 'b16533649';
  const perCdnTimeoutMs = Number(process.env.B24_LOADER_CDN_TIMEOUT_MS) || 1800;
  const totalTimeoutMs = Number(process.env.B24_LOADER_TOTAL_TIMEOUT_MS) || 7000;
  const deadline = Date.now() + totalTimeoutMs;
  const candidateBases = [];

  const envBases = String(process.env.B24_LOADER_CDN_BASES || process.env.BITRIX_LOADER_CDN_BASES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const base of envBases) {
    candidateBases.push(base.replace(/\/+$/, ''));
  }

  const defaultBases = [
    `https://cdn-ru.bitrix24.ru/${accountId}`,
    `https://cdn.bitrix24.com/${accountId}`,
    `https://cdn.bitrix24.ru/${accountId}`
  ];

  for (const base of defaultBases) {
    if (!candidateBases.includes(base)) candidateBases.push(base);
  }

  const fetchWithTimeout = async (url, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
      const body = await response.arrayBuffer();
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  };

  const buildUpstreamUrl = (base, id) => `${base}/crm/form/loader_${id}.js?${ts}`;

  async function fetchLoader(id) {
    let lastError = null;
    let lastResponse = null;
    let lastBody = null;
    let selectedBase = null;

    for (const base of candidateBases) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      try {
        const url = buildUpstreamUrl(base, id);
        const { response: resp, body } = await fetchWithTimeout(url, Math.min(perCdnTimeoutMs, remainingMs));
        if (resp && resp.ok) {
          selectedBase = base;
          return { resp, body, base };
        }
        lastResponse = resp;
        lastBody = body;
        lastError = new Error(`HTTP ${resp && resp.status ? resp.status : 'unknown'}`);
      } catch (error) {
        lastError = error;
      }
    }

    if (lastResponse) {
      return {
        resp: lastResponse,
        body: lastBody,
        base: selectedBase || candidateBases[0] || `https://cdn-ru.bitrix24.ru/${accountId}`
      };
    }

    throw lastError || new Error('Bitrix loader request failed');
  }

  function parseMetaFromJs(jsText) {
    const idMatch = jsText.match(/"id":"(\d+)"/) || jsText.match(/"id":(\d+)/);
    const secMatch = jsText.match(/"sec":"([a-zA-Z0-9]+)"/) || jsText.match(/"sec":\s*"?([a-zA-Z0-9]+)"?/);
    return {
      id: idMatch ? Number.parseInt(idMatch[1], 10) : null,
      sec: secMatch ? secMatch[1] : null
    };
  }

  try {
    let { resp, body, base } = await fetchLoader(formId);
    let usedFormId = formId;
    let usedFallback = false;

    // If requested form loader is unavailable, fallback to default form 739.
    if (!resp.ok && formId !== DEFAULT_FORM_ID) {
      try {
        const defaultLoad = await fetchLoader(DEFAULT_FORM_ID);
        resp = defaultLoad.resp;
        body = defaultLoad.body;
        base = defaultLoad.base;
        usedFormId = DEFAULT_FORM_ID;
        usedFallback = true;
        res.setHeader('x-loader-fallback', String(DEFAULT_FORM_ID));
      } catch (fallbackError) {
        console.warn('loader fallback failed', fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
      }
    }

    const buf = Buffer.from(body);
    const jsText = buf.toString('utf8');
    const parsedMeta = parseMetaFromJs(jsText);

    if (metaOnly) {
      return res.status(200).json({
        defaultFormId: DEFAULT_FORM_ID,
        requestedFormId: formId,
        usedFormId,
        usedFallback,
        resolvedFormId: parsedMeta.id || usedFormId,
        sec: parsedMeta.sec || null,
        upstreamBase: base || null
      });
    }

    // copy some caching headers from upstream when present
    const cacheControl = resp.headers.get('cache-control') || 'public, max-age=60';
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', cacheControl);
    res.setHeader('x-loader-provider', String(base || 'bitrix'));
    if (parsedMeta.id) res.setHeader('x-loader-form-id', String(parsedMeta.id));
    if (parsedMeta.sec) res.setHeader('x-loader-form-sec', parsedMeta.sec);
    const etag = resp.headers.get('etag');
    if (etag) res.setHeader('etag', etag);
    res.status(resp.status).send(buf);
  } catch (err) {
    console.error('loader proxy error', err && err.message || err);
    res.status(502).send('/* loader proxy error */');
  }
};
