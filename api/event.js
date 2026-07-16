export default function handler(req, res) {
  const query = req.query || require('url').parse(req.url, true).query;
  const id = query.id || query.EVPASSPORT_ID;
  if (!id) {
    return res.status(400).json({ error: 'Missing event id' });
  }

  const events = {
    '845': {
      name: 'Конференция InterPain 2026',
      date: '2026-09-15',
      city: 'Москва'
    }
  };

  const event = events[id] || {
    name: `Мероприятие №${id}`,
    date: '',
    city: ''
  };

  return res.status(200).json(event);
}
