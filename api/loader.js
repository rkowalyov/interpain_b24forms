// Proxy Bitrix loader to bypass client-side content blockers
// Returns fetched JS from Bitrix CDN with conservative cache headers
module.exports = async (req, res) => {
  const upstream = 'https://cdn-ru.bitrix24.ru/b16533649/crm/form/loader_739.js';
  const ts = req.query.ts || Date.now();
  const url = upstream + '?' + ts;
  try {
    const resp = await fetch(url, { redirect: 'follow' });
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
