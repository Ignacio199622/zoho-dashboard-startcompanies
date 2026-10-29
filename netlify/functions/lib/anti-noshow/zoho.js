// Capa de acceso a Zoho. SOLO LECTURA a proposito: en Fase 0 el agente no
// escribe nada en el CRM. No agregar funciones de escritura aca sin decidirlo
// explicitamente (ver README, seccion "Como se suelta").
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * El .env es el camino de la maquina. En Netlify ese archivo NO EXISTE y las
 * credenciales llegan por variables del sitio.
 *
 * El try no es decorativo: sin el, `readFileSync` tira al IMPORTAR el modulo y
 * se lleva puesta la funcion entera antes de correr una sola linea, sin dejar
 * ni un log util. Es la misma trampa que ya habia costado tiempo en
 * crm/auditoria/zoho.js.
 */
function delArchivo() {
  try {
    const txt = readFileSync(join(RAIZ, '.env'), 'utf8');
    return Object.fromEntries(
      txt
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

// process.env gana: en Netlify es la unica fuente, y en la maquina permite
// pisar un valor sin editar el archivo.
const env = { ...delArchivo(), ...process.env };
let cacheToken = null;

async function token() {
  if (cacheToken && Date.now() < cacheToken.venceEn) return cacheToken.valor;
  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const r = await fetch(`https://accounts.zoho.com/oauth/v2/token?${params}`, { method: 'POST' });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Zoho no devolvio token: ${JSON.stringify(j)}`);
  // Zoho da 3600s; renovamos 5 min antes por las dudas.
  cacheToken = { valor: j.access_token, venceEn: Date.now() + 55 * 60 * 1000 };
  return j.access_token;
}

async function get(path) {
  const t = await token();
  const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${t}` },
  });
  if (r.status === 204) return { data: [] };
  const txt = await r.text();
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error(`Respuesta no-JSON de ${path}: ${txt.slice(0, 200)}`);
  }
  if (j.status === 'error') throw new Error(`Zoho ${path}: ${j.code} ${j.message}`);
  return j;
}

const CAMPOS_EVENTO = [
  'id',
  'Event_Title',
  'Start_DateTime',
  'End_DateTime',
  'Status_del_Meet',
  'What_Id',
  'Who_Id',
  'Owner',
  'Venue',
  'Created_Time',
  'Cuentas_con_500_USD',
  'En_qu_estado_te_gustar_a_abrir_tu_LLC',
  'A_que_te_dedicas',
  'Cu_ndo_te_gustar_a_abrir_tu_LLC',
  'Para_qu_fin_necesitas_una_LLC',
].join(',');

const CAMPOS_LEAD = [
  'id',
  'Full_Name',
  'Phone',
  'Mobile',
  'Email',
  'Lead_Status',
  'Lead_Source',
  'Owner',
  'Retargeting',
  'Nombre_retargeting',
  'N_mero_de_mensaje',
  'Fecha_Siguiente_Mensaje',
  'Tag',
  'Calendario',
].join(',');

const CAMPOS_CONTACTO = ['id', 'Full_Name', 'Phone', 'Mobile', 'Email', 'Owner'].join(',');

// Zoho no acepta ordenar por Start_DateTime ("This field is not supported in
// sorting"), asi que la ventana se pide por criterio de busqueda. Listar por
// Created_Time y filtrar en memoria NO sirve: se pierden reuniones cargadas
// hace tiempo para una fecha proxima.
const iso = (d) => d.toISOString().replace('.000Z', '+00:00').replace(/\.\d{3}Z$/, '+00:00');

/** Reuniones cuyo inicio cae dentro de la ventana pedida. */
export async function reunionesEnVentana({ desde, hasta }) {
  const criteria = `((Start_DateTime:greater_equal:${iso(desde)})and(Start_DateTime:less_equal:${iso(hasta)}))`;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get(
      `Events/search?criteria=${encodeURIComponent(criteria)}&fields=${CAMPOS_EVENTO}&per_page=200&page=${page}`
    );
    const lote = j.data || [];
    out.push(...lote);
    if (!j.info?.more_records) break;
  }
  return out.sort((a, b) => new Date(a.Start_DateTime) - new Date(b.Start_DateTime));
}

/** Trae registros por lote de ids (Zoho acepta hasta 100 por request). */
async function porIds(modulo, campos, ids) {
  const unicos = [...new Set(ids.filter(Boolean))];
  const res = [];
  for (let i = 0; i < unicos.length; i += 100) {
    const tanda = unicos.slice(i, i + 100);
    const j = await get(`${modulo}?fields=${campos}&ids=${tanda.join(',')}`);
    res.push(...(j.data || []));
  }
  return Object.fromEntries(res.map((r) => [r.id, r]));
}

export const leadsPorId = (ids) => porIds('Leads', CAMPOS_LEAD, ids);
export const contactosPorId = (ids) => porIds('Contacts', CAMPOS_CONTACTO, ids);
