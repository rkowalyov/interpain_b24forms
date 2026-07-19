// Proxy Bitrix loader to bypass client-side content blockers
// Returns fetched JS from Bitrix CDN with conservative cache headers
module.exports = async (req, res) => {
  const DEFAULT_FORM_ID = 739;
  const rawFormId = req.query.formId || req.query.CRMFNUMBER;
  const parsedFormId = Number.parseInt(rawFormId, 10);
  const formId = Number.isInteger(parsedFormId) && parsedFormId > 0 ? parsedFormId : DEFAULT_FORM_ID;
  const ts = req.query.ts || Date.now();

  const buildUpstreamUrl = (id) => `https://cdn-ru.bitrix24.ru/b16533649/crm/form/loader_${id}.js?${ts}`;

  async function fetchLoader(id) {
    const resp = await fetch(buildUpstreamUrl(id), { redirect: 'follow' });
    return resp;
  }

  try {
    let resp = await fetchLoader(formId);

    // If requested form loader is unavailable, fallback to default form 739.
    if (!resp.ok && formId !== DEFAULT_FORM_ID) {
      resp = await fetchLoader(DEFAULT_FORM_ID);
      res.setHeader('x-loader-fallback', String(DEFAULT_FORM_ID));
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    // copy some caching headers from upstream when present
    const cacheControl = resp.headers.get('cache-control') || 'public, max-age=60';
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.setHeader('cache-control', cacheControl);
    const etag = resp.headers.get('etag');
    if (etag) res.setHeader('etag', etag);
    res.status(resp.status).send(buf);
  } catch (err) {
    console.error('loader proxy error', err && err.message || err);
    res.status(502).send('/* loader proxy error */');
  }
};
