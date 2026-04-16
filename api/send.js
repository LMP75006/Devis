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
    headers: { 'userApiKey': key, 'Accept': 'application/json' },
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

async function axonautPOST(path, body, company) {
  const key = getAxonautKey(company);
  const r = await fetch(`${AXONAUT_URL}${path}`, {
    method: 'POST',
    headers: { 'userApiKey': key, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(' ');
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
}

async function findOrCreateContact(d, company) {
  // 1. Chercher par email dans les sociétés (particuliers inclus)
  if (d.email) {
    const s = await axonautGET(`/companies?search=${encodeURIComponent(d.email)}`, company);
    if (s.ok && Array.isArray(s.data) && s.data.length > 0) {
      return { companyId: s.data[0].id, created: false };
    }
  }

  // 2. Chercher par nom
  if (d.name) {
    const sn = await axonautGET(`/companies?search=${encodeURIComponent(d.name)}`, company);
    if (sn.ok && Array.isArray(sn.data) && sn.data.length > 0) {
      return { companyId: sn.data[0].id, created: false };
    }
  }

  // 3. Créer la fiche particulier via /companies
  // Dans Axonaut, un particulier = société sans SIRET avec is_individual=true
  const { firstName, lastName } = splitName(d.name);
  const companyPayload = {
    name: d.name || 'Client',
    is_individual: true,
    email: d.email || '',
    phone: d.phone || '',
    address: d.address || '',
    first_name: firstName,
    last_name: lastName,
  };

  const c = await axonautPOST('/companies', companyPayload, company);
  if (!c.ok || !c.data || !c.data.id) {
    throw new Error(`Contact creation failed: ${JSON.stringify(c.data).substring(0, 300)}`);
  }

  console.log('Contact particulier créé:', c.data.id);
  return { companyId: c.data.id, created: true };
}

async function createAxonautQuote(d, companyId, company) {
  const products = (d.items || []).map(it => ({
    description: it.label + (it.isHaussmann ? ' (+30% Haussmann)' : ''),
    quantity: parseFloat(it.qty) || 1,
    price: parseFloat(it.priceHT) || 0,
    tax_rate: 20,
  }));

  if (d.disc && parseFloat(d.disc) > 0) {
    const discountAmount = parseFloat(((d.subtotal || 0) - (d.totalHT || 0)).toFixed(2));
    if (discountAmount > 0) {
      products.push({
        description: `Remise commerciale ${d.disc}%`,
        quantity: 1,
        price: -discountAmount,
        tax_rate: 20,
      });
    }
  }

  const noteLines = [
    `Référence Vasco : ${d.ref || ''}`,
    d.address          ? `Adresse : ${d.address}` : '',
    d.superficie       ? `Superficie : ${d.superficie} m²` : '',
    d.etage            ? `Étage : ${d.etage}` : '',
    d.ascenseur        ? `Ascenseur : ${d.ascenseur}` : '',
    d.logement         ? `Type de bien : ${d.logement}` : '',
    (d.subject && d.subject.length) ? `Sujet : ${Array.isArray(d.subject) ? d.subject.join(', ') : d.subject}` : '',
    d.dateIntervention ? `Intervention souhaitée : ${d.dateIntervention}` : '',
    d.freq             ? `Fréquence : ${d.freq}` : '',
    d.quoteType === 'custom' ? 'Type : Devis personnalisé' : 'Type : Devis classique',
    d.photosCount      ? `Photos jointes : ${d.photosCount}` : '',
    d.notes            ? `Notes : ${d.notes}` : '',
  ].filter(Boolean).join('\n');

  const payload = {
    reference: d.ref || '',
    company_id: companyId,
    products,
    comment: noteLines,
  };

  const r = await axonautPOST('/quotations', payload, company);
  if (r.ok && r.data && r.data.id) {
    return { success: true, axonautId: r.data.id };
  }
  throw new Error(`Quote creation failed: ${JSON.stringify(r.data).substring(0, 300)}`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html, fromName, fromEmail, devisData } = req.body;
  const results = { email: false, axonaut: null };

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
    } catch (e) { console.error('Email error:', e.message); }
  }

  if (devisData) {
    try {
      const company = devisData.company || 'lmp';
      const contact = await findOrCreateContact(devisData, company);
      const quote = await createAxonautQuote(devisData, contact.companyId, company);
      results.axonaut = { success: true, companyId: contact.companyId, contactCreated: contact.created, quoteId: quote.axonautId };
      console.log('Axonaut success:', JSON.stringify(results.axonaut));
    } catch (e) {
      console.error('Axonaut error:', e.message);
      results.axonaut = { success: false, error: e.message };
    }
  }

  return res.status(200).json({ success: true, results });
};
