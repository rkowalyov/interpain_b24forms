function getLeadWebhookUrl() {
  const raw = (process.env.BITRIX_WEBHOOK || process.env.B24_WEBHOOK_URL || '').trim();
  if (!raw) return '';

  const cleaned = raw.replace(/\/+$/, '');

  if (/\/crm\.lead\.add(?:\.json)?$/i.test(cleaned)) {
    return cleaned.replace(/(?:\.json)?$/i, '.json');
  }

  if (/\/[A-Za-z0-9_.-]+\.json$/i.test(cleaned)) {
    return cleaned.replace(/\/[A-Za-z0-9_.-]+\.json$/i, '/crm.lead.add.json');
  }

  return `${cleaned}/crm.lead.add.json`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = getLeadWebhookUrl();
  if (!url) {
    return res.status(500).json({ error: 'BITRIX_WEBHOOK or B24_WEBHOOK_URL is not configured' });
  }

  const fields = req.body && req.body.fields;
  if (!fields) {
    return res.status(400).json({ error: 'missing fields' });
  }

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
