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
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  return { firstName, lastName };
}

async function findOrCreateContact(d, company) {
  const { firstName, lastName } = splitName(d.name);

  // 1. Chercher par email
  if (d.email) {
    const s = await axonautGET(`/employees?search=${encodeURIComponent(d.email)}`, company);
    if (s.ok && Array.isArray(s.data) && s.data.length > 0) {
      console.log('Contact trouvé par email:', s.data[0].id);
      return { contactId: s.data[0].id, created: false };
    }
  }

  // 2. Chercher par nom
  if (d.name) {
    const sn = await axonautGET(`/employees?search=${encodeURIComponent(d.name)}`, company);
    if (sn.ok && Array.isArray(sn.data) && sn.data.length > 0) {
      console.log('Contact trouvé par nom:', sn.data[0].id);
      return { contactId: sn.data[0].id, created: false };
    }
  }

  // 3. Créer un particulier — pas de société
  const payload = {
    first_name: firstName,
    last_name: lastName || firstName,
    email: d.email || '',
    phone: d.phone || '',
    address: d.address || '',
    is_particular: true,
  };

  const r = await axonautPOST('/employees', payload, company);
  if (r.ok && r.data && r.data.id) {
    console.log('Contact particulier créé:', r.data.id);
    return { contactId: r.data.id, created: true };
  }
  throw new Error(`Contact creation failed: ${JSON.stringify(r.data).substring(0, 300)}`);
}

async function createAxonautQuote(d, contactId, company) {
  // Lignes produits
  const products = (d.items || []).map(it => ({
    description: it.label + (it.isHaussmann ? ' (+30% Haussmann)' : ''),
    quantity: parseFloat(it.qty) || 1,
    price: parseFloat(it.priceHT) || 0,
    tax_rate: 20,
  }));

  // Ligne remise si applicable
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

  // Notes complètes
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
    employee_id: contactId,
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
      const contact = await findOrCreateContact(devisData, company);
      const quote = await createAxonautQuote(devisData, contact.contactId, company);
      results.axonaut = {
        success: true,
        contactId: contact.contactId,
        contactCreated: contact.created,
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
