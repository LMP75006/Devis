// api/send.js — Vercel Serverless Function (CommonJS)
// - Pas d'emojis vers Axonaut
// - Produits réutilisés (recherche avant création)

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
  try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, data: text }; }
}

// Supprimer tous les emojis d'une chaîne
function stripEmojis(str) {
  return (str || '')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  return { address_street: street, address_zip_code: zip, address_city: city, address_country: 'France' };
}

// Recherche ou crée un produit dans le catalogue Axonaut
async function findOrCreateProduct(name, price, company) {
  const cleanName = stripEmojis(name);

  // Chercher dans le catalogue
  const search = await axonautREQ('GET', `/products?search=${encodeURIComponent(cleanName)}`, null, company);
  if (search.ok && Array.isArray(search.data) && search.data.length > 0) {
    // Trouver le produit dont le nom correspond exactement
    const exact = search.data.find(p =>
      stripEmojis(p.name || '').toLowerCase() === cleanName.toLowerCase()
    );
    if (exact) {
      console.log(`Produit existant réutilisé: "${cleanName}" (id:${exact.id})`);
      return exact.id;
    }
  }

  // Créer le produit une seule fois
  const create = await axonautREQ('POST', '/products', {
    name: cleanName,
    price,
    tax_rate: 20,
  }, company);

  if (create.ok && create.data && create.data.id) {
    console.log(`Nouveau produit créé: "${cleanName}" (id:${create.data.id})`);
    return create.data.id;
  }

  console.warn(`Impossible de créer le produit "${cleanName}", utilisation sans ID`);
  return null;
}

async function findOrCreateContact(d, company) {
  const { firstname, lastname } = splitName(d.name);
  const normalName = (d.name || '').trim().toLowerCase();

  // 1. Chercher par email — correspondance stricte sur les employees
  if (d.email) {
    const s = await axonautREQ('GET', `/companies?search=${encodeURIComponent(d.email)}`, null, company);
    if (s.ok && Array.isArray(s.data) && s.data.length > 0) {
      // Vérifier que l'email correspond vraiment à un employee de la fiche
      for (const co of s.data) {
        const employees = co.employees || [];
        const match = employees.find(e => (e.email || '').toLowerCase() === d.email.toLowerCase());
        if (match) {
          console.log(`Client trouvé par email: ${co.name} (id: ${co.id})`);
          return { companyId: co.id, created: false };
        }
      }
      // Fallback : premier résultat si pas d'employee visible
      console.log(`Client trouvé par email (fallback): ${s.data[0].name} (id: ${s.data[0].id})`);
      return { companyId: s.data[0].id, created: false };
    }
  }

  // 2. Chercher par nom — correspondance stricte
  if (d.name) {
    const sn = await axonautREQ('GET', `/companies?search=${encodeURIComponent(d.name)}`, null, company);
    if (sn.ok && Array.isArray(sn.data) && sn.data.length > 0) {
      // Chercher correspondance exacte sur le nom
      const exactMatch = sn.data.find(co => (co.name || '').trim().toLowerCase() === normalName);
      if (exactMatch) {
        console.log(`Client trouvé par nom exact: ${exactMatch.name} (id: ${exactMatch.id})`);
        return { companyId: exactMatch.id, created: false };
      }
      // Chercher par prénom + nom dans les employees
      const nameMatch = sn.data.find(co => {
        const employees = co.employees || [];
        return employees.find(e => {
          const fullName = `${e.firstname || ''} ${e.lastname || ''}`.trim().toLowerCase();
          return fullName === normalName;
        });
      });
      if (nameMatch) {
        console.log(`Client trouvé par nom employee: ${nameMatch.name} (id: ${nameMatch.id})`);
        return { companyId: nameMatch.id, created: false };
      }
    }
  }

  // 3. Chercher par prénom seul + nom seul séparément
  if (firstname && lastname) {
    const sf = await axonautREQ('GET', `/companies?search=${encodeURIComponent(lastname)}`, null, company);
    if (sf.ok && Array.isArray(sf.data) && sf.data.length > 0) {
      const nameMatch = sf.data.find(co => (co.name || '').trim().toLowerCase() === normalName);
      if (nameMatch) {
        console.log(`Client trouvé par nom de famille: ${nameMatch.name} (id: ${nameMatch.id})`);
        return { companyId: nameMatch.id, created: false };
      }
    }
  }

  // 4. Aucun client trouvé → créer
  const addr = parseAddress(d.address);

  const companyPayload = {
    name: d.name || 'Client',
    isB2C: true,
    is_prospect: true,
    is_customer: true,
    currency: 'EUR',
    language: 'fr',
    ...addr,
    comments: [
      d.logement   ? `Type de bien : ${d.logement}` : '',
      d.superficie ? `Superficie : ${d.superficie} m²` : '',
      d.etage      ? `Etage : ${d.etage}` : '',
      d.ascenseur  ? `Ascenseur : ${d.ascenseur}` : '',
    ].filter(Boolean).join(' | '),
    employees: [{
      firstname,
      lastname,
      email: d.email || '',
      cellphoneNumber: d.phone || '',
      is_billing_contact: true,
    }],
  };

  const c = await axonautREQ('POST', '/companies', companyPayload, company);
  if (!c.ok || !c.data || !c.data.id) {
    throw new Error(`Company creation failed: ${JSON.stringify(c.data).substring(0, 300)}`);
  }
  return { companyId: c.data.id, created: true };
}

async function createAxonautQuote(d, companyId, company) {
  // Frais de déplacement toujours en dernière ligne
  const allItems = d.items || [];
  const transportItems = allItems.filter(it => it.serviceKey === 'transport' || stripEmojis(it.label || '').toLowerCase().includes('deplacement'));
  const otherItems = allItems.filter(it => it.serviceKey !== 'transport' && !stripEmojis(it.label || '').toLowerCase().includes('deplacement'));
  const orderedItems = [...otherItems, ...transportItems];

  // Construire les produits en réutilisant les existants
  const products = [];
  for (const it of orderedItems) {
    const cleanLabel = stripEmojis(it.label) + (it.isHaussmann ? ' (+30% Haussmann)' : '');
    const productId = await findOrCreateProduct(cleanLabel, parseFloat(it.priceHT) || 0, company);

    const line = {
      name: cleanLabel,
      price: parseFloat(parseFloat(it.priceHT).toFixed(2)),
      tax_rate: 20,
      quantity: parseFloat(it.qty) || 1,
      unit: it.unit || '',
    };
    if (productId) line.id = productId;
    products.push(line);
  }

  // Remise — ligne directe sans passer par le catalogue produits
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

  // Commentaire sans emojis
  const comments = [
    `Reference Vasco : ${d.ref || ''}`,
    (d.subject && d.subject.length) ? `Sujet : ${Array.isArray(d.subject) ? d.subject.join(', ') : d.subject}` : '',
    d.dateIntervention ? `Intervention souhaitee : ${d.dateIntervention}` : '',
    d.freq             ? `Frequence : ${d.freq}` : '',
    d.quoteType === 'custom' ? 'Type : Devis personnalise' : 'Type : Devis classique',
    d.photosCount      ? `Photos jointes : ${d.photosCount}` : '',
    d.notes            ? `Notes : ${d.notes}` : '',
  ].filter(Boolean).join('\n');

  function toRFC3339(date) {
    const pad = n => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const hh = pad(Math.floor(absOffset / 60));
    const mm = pad(absOffset % 60);
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hh}:${mm}`;
  }

  const payload = {
    company_id: companyId,
    date: toRFC3339(new Date()),
    expiry_date: toRFC3339(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    comments,
    products,
  };

  const r = await axonautREQ('POST', '/quotations', payload, company);
  if (r.ok && r.data && r.data.id) {
    console.log('Devis Axonaut créé:', r.data.id, '— TTC:', r.data.total_amount);
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

  // Email
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

  // Axonaut
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
      console.log('Axonaut success:', JSON.stringify(results.axonaut));
    } catch (e) {
      console.error('Axonaut error:', e.message);
      results.axonaut = { success: false, error: e.message };
    }
  }

  return res.status(200).json({ success: true, results });
};
