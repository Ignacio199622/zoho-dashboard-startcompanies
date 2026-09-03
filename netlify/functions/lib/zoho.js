// Zoho, SOLO LECTURA en esta fase. El agente todavia no escribe nada:
// primero se mira lo que extrajo, despues se decide que campos cargar.
import { env } from './fathom.js';

let cache = null;

async function token() {
  if (cache && Date.now() < cache.exp) return cache.v;
  const p = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const j = await (await fetch(`https://accounts.zoho.com/oauth/v2/token?${p}`, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho no devolvio token');
  cache = { v: j.access_token, exp: Date.now() + 55 * 60 * 1000 };
  return j.access_token;
}

async function get(path) {
  const t = await token();
  const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${t}` },
  });
  if (r.status === 204) return { data: [] };
  const j = await r.json();
  if (j.status === 'error') return { data: [], error: `${j.code} ${j.message}` };
  return j;
}

const CAMPOS = [
  'id', 'Full_Name', 'Email', 'Phone', 'Mobile', 'Lead_Status', 'Lead_Source',
  'Owner', 'Description', 'Landing_Origen', 'Modalidad_de_Cierre', 'Modalidad_de_Pago',
  'Created_Time',
].join(',');

/** Busca el lead por mail. Es la clave mas confiable para cruzar Fathom con el CRM. */
export async function leadPorMail(mail) {
  if (!mail) return null;
  const j = await get(`Leads/search?criteria=(Email:equals:${encodeURIComponent(mail)})&fields=${CAMPOS}`);
  return (j.data || [])[0] || null;
}

/** Que campos del lead estan vacios hoy: es el "antes" del agente. */
export function camposVacios(lead) {
  if (!lead) return [];
  const mirar = {
    'Quien atendio (Owner)': lead.Owner?.name === 'Start Companies Staff' ? null : lead.Owner?.name,
    'Landing Origen': lead.Landing_Origen,
    'Modalidad de cierre': lead.Modalidad_de_Cierre,
    'Modalidad de pago': lead.Modalidad_de_Pago,
    'Descripcion': lead.Description,
  };
  return Object.entries(mirar)
    .filter(([, v]) => v === null || v === undefined || v === '')
    .map(([k]) => k);
}
