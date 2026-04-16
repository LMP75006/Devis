// api/send.js — Vercel Serverless Function (CommonJS)

const AXONAUT_URL = 'https://axonaut.com/api/v2';

function getAxonautKey(company) {
  return company === 'fraioli'
    ? process.env.AXONAUT_KEY_FRAIOLI
    : process.env.AXONAUT_KEY_LMP;
}

async function axonautGET(path, company) {
  const key = getAxonautKey(company);
  const r = await fetch(`${AXONAUT_URL}${path}`, {
    method: 'GET',
    headers: {
      'userApiKey': key,
      'Accept': 'application/json',
    },
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

async function axonautPOST(path, body, company) {
  const key = getAxonautKey(company);
  const r = await fetch(`${AXONAUT_URL}${path}`, {
    method: 'POST',
    headers: {
      'userApiKey': key,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

async function findOrCreateCustomer(d, company) {
  const nameParts = (d.name || '').trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || firstName;

  // Chercher par email
  if (d.email) {
    const s = await axonautGET(`/companies?search=${encodeURIComponent(d.email)}`, company);
    if (s.ok && Array.isArray(s.data) && s.data.length > 0) {
      return { id: s.data[0].id, created: false };
    }
  }

  // Chercher par nom
  const sn = await axonautGET(`/companies?search=${encodeURIComponent(d.name || '')}`, company);
  if (sn.ok && Array.isArray(sn.data) && sn.data.length > 0) {
    return { id: sn.data[0].id, created: false };
  }

  // Créer le client — endpoint /companies avec company_name requis
  const payload = {
    name: d.name || 'Client',
    employees: [
      {
        first_name: firstName,
        last_name: lastName,
        email: d.email || '',
        phone: d.phone || '',
        is_main_contact: true,
      }
    ],
    address: d.address || '',
  };

  const c = await axonautPOST('/companies', payload, company);
  if (c.ok && c.data && c.data.id) {
    return { id: c.data.id, created: true };
  }
  throw new Error(`Customer creation failed: ${JSON.stringify(c.data).substring(0, 200)}`);
}

async function createAxonautQuote(d, companyId, company) {
  const products = (d.items || []).map(it => ({
    name: it.label + (it.isHaussmann ? ' (+30%)' : ''),
    quantity: it.qty,
    unit_price: it.priceHT,
    tax: 20,
  }));

  const notes = [
    d.address ? `Adresse : ${d.address}` : '',
    d.superficie ? `Superficie : ${d.superficie} m²` : '',
    d.freq ? `Fréquence : ${d.freq}` : '',
    d.dateIntervention ? `Intervention souhaitée : ${d.dateIntervention}` : '',
    d.notes || '',
  ].filter(Boolean).join('\n');

  const payload = {
    reference: d.ref,
    company_id: companyId,
    products,
    comment: notes,
  };

  const r = await axonautPOST('/quotations', payload, company);
  if (r.ok && r.data && r.data.id) {
    return { success: true, axonautId: r.data.id };
  }
  throw new Error(`Quote creation failed: ${JSON.stringify(r.data).substring(0, 200)}`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html, fromName, fromEmail, devisData } = req.body;
  const results = { email: false, axonaut: null };

  // ── Email ──────────────────────────────────────────────────────────────────
  if (to && subject && html) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName || 'La Maison Propre'} <${fromEmail || 'contact@lamaisonpropre.fr'}>`,
          to: [to],
          subject,
          html,
        }),
      });
      results.email = r.ok;
      if (!r.ok) console.error('Resend error:', await r.text());
    } catch (e) {
      console.error('Email error:', e.message);
    }
  }

  // ── Axonaut ────────────────────────────────────────────────────────────────
  if (devisData) {
    try {
      const company = devisData.company || 'lmp';
      const customer = await findOrCreateCustomer(devisData, company);
      const quote = await createAxonautQuote(devisData, customer.id, company);
      results.axonaut = {
        success: true,
        companyId: customer.id,
        customerCreated: customer.created,
        quoteId: quote.axonautId,
      };
      console.log('Axonaut success:', JSON.stringify(results.axonaut));
    } catch (e) {
      console.error('Axonaut error:', e.message);
      results.axonaut = { success: false, error: e.message };
    }
  }

  return res.status(200).json({ success: true, results });
};
