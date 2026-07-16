export default function handler(req, res) {
  const { id } = req.query;
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
