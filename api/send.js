// api/send.js — Vercel Serverless Function (CommonJS)

const AXONAUT_URL = 'https://axonaut.com/api/v2';

function getAxonautKey(company) {
  return company === 'fraioli'
    ? process.env.AXONAUT_KEY_FRAIOLI
    : process.env.AXONAUT_KEY_LMP;
}

async function axonautRequest(method, path, body, company) {
  const key = getAxonautKey(company);
  const r = await fetch(`${AXONAUT_URL}${path}`, {
    method,
    headers: { 'userApiKey': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

async function findOrCreateCustomer(d, company) {
  const nameParts = (d.name || '').trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  if (d.email) {
    const s = await axonautRequest('GET', `/customers?search=${encodeURIComponent(d.email)}`, null, company);
    if (s.ok && s.data?.length > 0) return { id: s.data[0].id, created: false };
  }
  const sn = await axonautRequest('GET', `/customers?search=${encodeURIComponent(d.name || '')}`, null, company);
  if (sn.ok && sn.data?.length > 0) return { id: sn.data[0].id, created: false };
  const c = await axonautRequest('POST', '/customers', {
    first_name: firstName, last_name: lastName,
    email: d.email || '', phone: d.phone || '',
    address: d.address || '', type: 'customer',
  }, company);
  if (c.ok && c.data?.id) return { id: c.data.id, created: true };
  throw new Error(`Customer creation failed: ${JSON.stringify(c.data)}`);
}

async function createAxonautQuote(d, customerId, company) {
  const lines = (d.items || []).map(it => ({
    description: it.label + (it.isHaussmann ? ' (+30%)' : ''),
    quantity: it.qty,
    unit_price: it.priceHT,
    taxes: [{ rate: 20 }],
  }));
  const notes = [
    d.address ? `Adresse : ${d.address}` : '',
    d.superficie ? `Superficie : ${d.superficie} m²` : '',
    d.freq ? `Fréquence : ${d.freq}` : '',
    d.dateIntervention ? `Intervention souhaitée : ${d.dateIntervention}` : '',
    d.notes || '',
  ].filter(Boolean).join('\n');
  const r = await axonautRequest('POST', '/quotes', {
    reference: d.ref, customer_id: customerId, lines, notes, status: 'draft',
  }, company);
  if (r.ok) return { success: true, axonautId: r.data?.id };
  throw new Error(`Quote creation failed: ${JSON.stringify(r.data)}`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html, fromName, fromEmail, devisData } = req.body;
  const results = { email: false, axonaut: null };

  // Email
  if (to && subject && html) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${fromName || 'La Maison Propre'} <${fromEmail || 'contact@lamaisonpropre.fr'}>`,
          to: [to], subject, html,
        }),
      });
      results.email = r.ok;
      if (!r.ok) console.error('Resend error:', await r.text());
    } catch (e) { console.error('Email error:', e); }
  }

  // Axonaut
  if (devisData) {
    try {
      const company = devisData.company || 'lmp';
      const customer = await findOrCreateCustomer(devisData, company);
      const quote = await createAxonautQuote(devisData, customer.id, company);
      results.axonaut = { success: true, customerId: customer.id, customerCreated: customer.created, quoteId: quote.axonautId };
    } catch (e) {
      console.error('Axonaut error:', e);
      results.axonaut = { success: false, error: e.message };
    }
  }

  return res.status(200).json({ success: true, results });
};
