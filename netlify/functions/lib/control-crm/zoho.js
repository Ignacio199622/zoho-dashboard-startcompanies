// Cliente Zoho compartido. SOLO LECTURA.
//
// Guarda el token en salidas/.token.json: Zoho corta con "too many requests"
// si cada script pide su propio refresh, y corriendo varios seguidos se llega
// enseguida. Con esto, todos reusan el mismo token durante 55 minutos.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = dirname(fileURLToPath(import.meta.url));
export const SALIDAS = join(RAIZ, 'salidas');
const CACHE = join(SALIDAS, '.token.json');

// El .env es la fuente en la maquina. En Netlify ese archivo no existe y las
// credenciales llegan por process.env, asi que la lectura no puede ser fatal:
// sin el try esto tiraba al importar el modulo y se llevaba puesta la funcion
// entera antes de correr una sola linea. process.env pisa al archivo.
function delArchivo() {
  try {
    return Object.fromEntries(
      readFileSync(join(RAIZ, '.env'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    );
  } catch {
    return {};
  }
}

const env = { ...delArchivo(), ...process.env };

let memoria = null;
async function token() {
  if (memoria && Date.now() < memoria.exp) return memoria.v;
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8'));
      if (Date.now() < c.exp) { memoria = c; return c.v; }
    } catch { /* cache rota, se pide de nuevo */ }
  }
  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN, client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET, grant_type: 'refresh_token',
  });
  const j = await (await fetch(`https://accounts.zoho.com/oauth/v2/token?${params}`, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho no devolvio token: ' + JSON.stringify(j));
  memoria = { v: j.access_token, exp: Date.now() + 55 * 60 * 1000 };
  try { writeFileSync(CACHE, JSON.stringify(memoria)); } catch { /* sin cache, igual anda */ }
  return memoria.v;
}

export let llamadas = 0;

async function pedir(path) {
  const t = await token();
  llamadas++;
  const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${t}` },
  });
  if (r.status === 204) return {};
  if (r.status === 429) throw new Error('429: Zoho corto por volumen de llamadas');
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { return { _status: r.status, _raw: txt.slice(0, 300) }; }
  if (j.status === 'error') return { _error: j.code, _mensaje: j.message };
  return j;
}

export async function get(path) {
  const j = await pedir(path);
  // El token cacheado puede haber vencido antes de los 55 minutos si otro
  // proceso pidio un refresh. Se tira el cache y se reintenta una sola vez.
  if (j._error === 'INVALID_TOKEN' || j._error === 'AUTHENTICATION_FAILURE') {
    memoria = null;
    try { if (existsSync(CACHE)) unlinkSync(CACHE); } catch { /* si no se puede borrar, el reintento igual pide uno nuevo */ }
    const reintento = await pedir(path);
    // Un problema de credenciales NO puede devolverse como dato vacio: un
    // agente que dice "todo bien" porque no pudo leer es peor que uno roto.
    if (reintento._error === 'INVALID_TOKEN' || reintento._error === 'AUTHENTICATION_FAILURE') {
      throw new Error(`Zoho rechazo el token: ${reintento._error} ${reintento._mensaje || ''}`);
    }
    return reintento;
  }
  return j;
}

export async function paginado(modulo, campos, extra = '', maxLotes = 200) {
  const out = [];
  let pageToken = null;
  let page = 1;
  for (let i = 0; i < maxLotes; i++) {
    const base = `${modulo}?fields=${campos}&sort_by=Created_Time&sort_order=desc&per_page=200${extra}`;
    const j = await get(pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : `${base}&page=${page}`);
    if (j._error) { process.stderr.write(`\r  ${modulo}: ${j._error}\n`); break; }
    out.push(...(j.data || []));
    process.stderr.write(`\r  ${modulo}: ${out.length}   `);
    if (!j.info?.more_records) break;
    pageToken = j.info?.next_page_token || null;
    if (!pageToken) { page++; if (page * 200 > 2000) break; }
  }
  process.stderr.write('\n');
  return out;
}

// Cuenta registros sin traerlos. `info.count` de una pagina cuenta esa pagina,
// no el modulo: el total real lo da /actions/count.
export async function contar(modulo) {
  const j = await get(`${modulo}/actions/count`);
  if (j._error) return { total: null, error: j._error };
  return { total: typeof j.count === 'number' ? j.count : null };
}

export async function campos(modulo) {
  const j = await get(`settings/fields?module=${modulo}`);
  return j.fields || [];
}

export async function modulos() {
  const j = await get('settings/modules');
  return j.modules || [];
}
