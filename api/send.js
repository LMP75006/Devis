// api/send.js — Vercel Serverless Function (CommonJS)
// Version finale — doc officielle Axonaut API v2 lue intégralement

const AXONAUT_URL = 'https://axonaut.com/api/v2';

function getAxonautKey(company) {
  return company === 'fraioli'
    ? process.env.AXONAUT_KEY_FRAIOLI
    : process.env.AXONAUT_KEY_LMP;
}

async function axonautREQ(method, path, body, company) {
  const key = getAxonautKey(company);
  const opts = {
    method,
    headers: { 'userApiKey': key, 'Accept': 'application/json', 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${AXONAUT_URL}${path}`, opts);
  const text = await r.text();
  console.log(`[${method}] ${path} → ${r.status} | ${text.substring(0, 300)}`);
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(' ');
  const firstname = parts[0] || '';
  const lastname = parts.slice(1).join(' ') || '';
  return { firstname, lastname };
}

function parseAddress(address) {
  if (!address) return {};
  const parts = address.split(',');
  const street = (parts[0] || '').trim();
  const rest = (parts[1] || '').trim();
  const zipMatch = rest.match(/(\d{5})/);
  const zip = zipMatch ? zipMatch[1] : '';
  const city = rest.replace(zip, '').trim();
  return {
    address_street: street,
    address_zip_code: zip,
    address_city: city,
    address_country: 'France',
  };
}

async function findOrCreateContact(d, company) {
  // 1. Chercher par email
  if (d.email) {
    const s = await axonautREQ('GET', `/companies?search=${encodeURIComponent(d.email)}`, null, company);
    if (s.ok && Array.isArray(s.data) && s.data.length > 0) {
      return { companyId: s.data[0].id, created: false };
    }
  }
  // 2. Chercher par nom
  if (d.name) {
    const sn = await axonautREQ('GET', `/companies?search=${encodeURIComponent(d.name)}`, null, company);
    if (sn.ok && Array.isArray(sn.data) && sn.data.length > 0) {
      return { companyId: sn.data[0].id, created: false };
    }
  }

  // 3. Créer le particulier via POST /companies avec isB2C:true
  // Doc: "If the company is a B2C company, set isB2C to true and provide one employee.
  //       The company name will be overwritten by firstname+lastname of the employee."
  const { firstname, lastname } = splitName(d.name);
  const addr = parseAddress(d.address);

  const companyPayload = {
    name: d.name || 'Client',
    isB2C: true,
    is_prospect: true,
    is_customer: true,
    currency: 'EUR',
    language: 'fr',
    ...addr,
    // Infos bien utiles dans les commentaires de la fiche
    comments: [
      d.logement   ? `Type de bien : ${d.logement}` : '',
      d.superficie ? `Superficie : ${d.superficie} m²` : '',
      d.etage      ? `Étage : ${d.etage}` : '',
      d.ascenseur  ? `Ascenseur : ${d.ascenseur}` : '',
    ].filter(Boolean).join(' | '),
    // Doc: employees array only used if isB2C is true
    // champs: firstname, lastname, email, cellphoneNumber (camelCase dans POST /companies)
    employees: [{
      firstname,
      lastname,
      email: d.email || '',
      cellphoneNumber: d.phone || '',   // camelCase dans POST /companies
      is_billing_contact: true,
    }],
  };

  const c = await axonautREQ('POST', '/companies', companyPayload, company);
  if (!c.ok || !c.data || !c.data.id) {
    throw new Error(`Company creation failed: ${JSON.stringify(c.data).substring(0, 300)}`);
  }

  const companyId = c.data.id;
  console.log('Particulier créé, company_id:', companyId);
  return { companyId, created: true };
}

async function createAxonautQuote(d, companyId, company) {
  // Doc POST /quotations : products[].name, price, tax_rate, quantity, unit
  const products = (d.items || []).map(it => ({
    name: it.label + (it.isHaussmann ? ' (+30% Haussmann)' : ''),
    price: parseFloat(parseFloat(it.priceHT).toFixed(2)),
    tax_rate: 20,
    quantity: parseFloat(it.qty) || 1,
    unit: it.unit || '',
  }));

  // Remise si applicable
  if (d.disc && parseFloat(d.disc) > 0) {
    const discountAmt = parseFloat(((d.subtotal || 0) - (d.totalHT || 0)).toFixed(2));
    if (discountAmt > 0) {
      products.push({
        name: `Remise commerciale ${d.disc}%`,
        price: -discountAmt,
        tax_rate: 20,
        quantity: 1,
      });
    }
  }

  // Toutes les infos Vasco dans le champ comments du devis
  const comments = [
    `Référence Vasco : ${d.ref || ''}`,
    (d.subject && d.subject.length) ? `Sujet : ${Array.isArray(d.subject) ? d.subject.join(', ') : d.subject}` : '',
    d.dateIntervention ? `Date d'intervention souhaitée : ${d.dateIntervention}` : '',
    d.freq             ? `Fréquence : ${d.freq}` : '',
    d.quoteType === 'custom' ? 'Type : Devis personnalisé (heures libres)' : 'Type : Devis classique (catalogue)',
    d.photosCount      ? `Photos jointes : ${d.photosCount}` : '',
    d.notes            ? `Notes : ${d.notes}` : '',
  ].filter(Boolean).join('\n');

  // Dates RFC3339 avec offset timezone explicite (requis par Axonaut)
  function toRFC3339(date) {
    const pad = n => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const hh = pad(Math.floor(absOffset / 60));
    const mm = pad(absOffset % 60);
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hh}:${mm}`;
  }
  const now = toRFC3339(new Date());
  const expiry = toRFC3339(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  const payload = {
    company_id: companyId,
    date: now,
    expiry_date: expiry,
    comments,
    products,
  };

  const r = await axonautREQ('POST', '/quotations', payload, company);
  if (r.ok && r.data && r.data.id) {
    console.log('Devis créé:', r.data.id, '— TTC:', r.data.total_amount);
    return { success: true, axonautId: r.data.id };
  }
  throw new Error(`Quotation creation failed: ${JSON.stringify(r.data).substring(0, 300)}`);
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
          to: [to], subject, html,
        }),
      });
      results.email = r.ok;
      if (!r.ok) console.error('Resend error:', await r.text());
    } catch (e) { console.error('Email error:', e.message); }
  }

  // ── Axonaut ────────────────────────────────────────────────────────────────
  if (devisData) {
    try {
      const company = devisData.company || 'lmp';
      const contact = await findOrCreateContact(devisData, company);
      const quote = await createAxonautQuote(devisData, contact.companyId, company);
      results.axonaut = {
        success: true,
        companyId: contact.companyId,
        contactCreated: contact.created,
        quoteId: quote.axonautId,
      };
      console.log('✅ Axonaut success:', JSON.stringify(results.axonaut));
    } catch (e) {
      console.error('❌ Axonaut error:', e.message);
      results.axonaut = { success: false, error: e.message };
    }
  }

  return res.status(200).json({ success: true, results });
};
