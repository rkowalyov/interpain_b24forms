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
  const loaderPath = `/crm/form/loader_${formId}.js?${ts}`;
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

  const fetchWithTimeout = async (url, timeoutMs = 6000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const buildUpstreamUrl = (base, id) => `${base}/crm/form/loader_${id}.js?${ts}`;

  async function fetchLoader(id) {
    let lastError = null;
    let lastResponse = null;
    let selectedBase = null;

    for (const base of candidateBases) {
      try {
        const url = buildUpstreamUrl(base, id);
        const resp = await fetchWithTimeout(url, 6000);
        if (resp && resp.ok) {
          selectedBase = base;
          return { resp, base };
        }
        lastResponse = resp;
        lastError = new Error(`HTTP ${resp && resp.status ? resp.status : 'unknown'}`);
      } catch (error) {
        lastError = error;
      }
    }

    if (lastResponse) {
      return { resp: lastResponse, base: selectedBase || candidateBases[0] || `https://cdn-ru.bitrix24.ru/${accountId}` };
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
    let { resp, base } = await fetchLoader(formId);
    let usedFormId = formId;
    let usedFallback = false;

    // If requested form loader is unavailable, fallback to default form 739.
    if (!resp.ok && formId !== DEFAULT_FORM_ID) {
      try {
        const defaultLoad = await fetchLoader(DEFAULT_FORM_ID);
        resp = defaultLoad.resp;
        base = defaultLoad.base;
        usedFormId = DEFAULT_FORM_ID;
        usedFallback = true;
        res.setHeader('x-loader-fallback', String(DEFAULT_FORM_ID));
      } catch (fallbackError) {
        console.warn('loader fallback failed', fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
      }
    }

    const buf = Buffer.from(await resp.arrayBuffer());
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
