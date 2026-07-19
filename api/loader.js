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

  const buildUpstreamUrl = (id) => `https://cdn-ru.bitrix24.ru/b16533649/crm/form/loader_${id}.js?${ts}`;

  async function fetchLoader(id) {
    const resp = await fetch(buildUpstreamUrl(id), { redirect: 'follow' });
    return resp;
  }

  function parseMetaFromJs(jsText) {
    const idMatch = jsText.match(/"id":"(\d+)"/);
    const secMatch = jsText.match(/"sec":"([a-zA-Z0-9]+)"/);
    return {
      id: idMatch ? Number.parseInt(idMatch[1], 10) : null,
      sec: secMatch ? secMatch[1] : null
    };
  }

  try {
    let resp = await fetchLoader(formId);
    let usedFormId = formId;
    let usedFallback = false;

    // If requested form loader is unavailable, fallback to default form 739.
    if (!resp.ok && formId !== DEFAULT_FORM_ID) {
      resp = await fetchLoader(DEFAULT_FORM_ID);
      usedFormId = DEFAULT_FORM_ID;
      usedFallback = true;
      res.setHeader('x-loader-fallback', String(DEFAULT_FORM_ID));
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
        sec: parsedMeta.sec || null
      });
    }

    // copy some caching headers from upstream when present
    const cacheControl = resp.headers.get('cache-control') || 'public, max-age=60';
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', cacheControl);
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
