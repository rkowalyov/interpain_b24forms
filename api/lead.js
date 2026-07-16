export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhook = process.env.BITRIX_WEBHOOK;
  if (!webhook) {
    return res.status(500).json({ error: 'BITRIX_WEBHOOK is not configured' });
  }

  const fields = req.body && req.body.fields;
  if (!fields) {
    return res.status(400).json({ error: 'missing fields' });
  }

  const url = webhook.replace(/\/+$/, '').replace(/\.json$/, '') + '.json';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('[Vercel API] Error forwarding to Bitrix:', error);
    return res.status(502).json({ error: error.message });
  }
}
