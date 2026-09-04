// Acceso a Zoho. SOLO LECTURA, a proposito.
//
// Este agente NO escribe en el CRM y NO manda WhatsApp. Modificar un registro
// en este CRM puede disparar un envio al cliente: en agosto de 2026 una regla
// en bucle mando la misma plantilla cada 3 minutos hasta que Meta bloqueo el
// numero. No agregar funciones de escritura aca sin decidirlo explicitamente.
import { env } from './entorno.js';
import { limpiar } from './texto.js';

const API = 'https://www.zohoapis.com/crm/v6';

let cacheToken = null;

// Exportado para `escritura.js`, que necesita el mismo token pero hace PUT.
// Pedir el token no es escribir: la separacion sigue siendo el archivo que
// tiene los PUT, no el que tiene las credenciales.
export async function token() {
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
  cacheToken = { valor: j.access_token, venceEn: Date.now() + 55 * 60 * 1000 };
  return j.access_token;
}

export async function get(path, cabeceras = {}) {
  const t = await token();
  const r = await fetch(`${API}/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${t}`, ...cabeceras },
  });
  // 204 = sin resultados, 304 = nada cambio desde If-Modified-Since.
  if (r.status === 204 || r.status === 304) return { data: [], info: {} };
  const txt = await r.text();
  if (!txt.trim()) return { data: [], info: {} };
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error(`Respuesta no-JSON de ${path}: ${txt.slice(0, 200)}`);
  }
  if (j.status === 'error') throw new Error(`Zoho ${path}: ${j.code} ${j.message}`);
  return j;
}

// El modulo de mensajes de WhatsApp. Ojo con dos cosas verificadas a mano:
//
//  1. Sin `fields=` explicito el modulo devuelve 400. No hay lectura "de todo".
//  2. `/search` no existe para este modulo y `sort_by` solo acepta `id` o
//     `Modified_Time`. Por eso la ventana se pide con If-Modified-Since y no
//     con un criterio de busqueda.
//
// Es UN registro por conversacion (un numero de telefono), actualizado en el
// lugar. `last_message__s` es el ultimo mensaje, no hay historial por API.
const CAMPOS = [
  'mobile_number__s',
  'last_message__s',
  'conversation_status__s',
  'message_time__s',
  'sender__s',
  'replied_by__s',
].join(',');

/** Conversaciones con movimiento desde `desde` (Date). Suele ser 1 sola llamada. */
export async function conversacionesDesde(desde) {
  const cabecera = { 'If-Modified-Since': desde.toISOString().replace(/\.\d{3}Z$/, '+00:00') };
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get(`messages__s?fields=${CAMPOS}&per_page=200&page=${page}`, cabecera);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  return out.map((c) => ({ ...c, last_message__s: limpiar(c.last_message__s) }));
}

/**
 * Barrido completo de las 10.313 conversaciones. Son ~52 llamadas y unos 20s.
 * NO se usa en la corrida normal (esa va con If-Modified-Since y es 1 llamada):
 * esto es para la foto del backlog, cuando se quiere ver todo lo que quedo
 * esperando desde siempre.
 *
 * Se pagina con `page_token`, no con `page=`: la paginacion normal corta en el
 * registro 2000 y devuelve error.
 */
export async function todasLasConversaciones({ alAvanzar } = {}) {
  const out = [];
  let token = null;
  for (let i = 0; i < 120; i++) {
    const j = await get(`messages__s?fields=${CAMPOS}&per_page=200${token ? `&page_token=${token}` : ''}`);
    const lote = j.data || [];
    out.push(...lote);
    if (alAvanzar) alAvanzar(out.length);
    token = j.info?.next_page_token;
    if (!token || !lote.length) break;
  }
  return out.map((c) => ({ ...c, last_message__s: limpiar(c.last_message__s) }));
}

const CAMPOS_POR_MODULO = {
  Contacts: 'id,Full_Name,Phone,Mobile,Email,Owner',
  Leads: 'id,Full_Name,Phone,Mobile,Email,Owner,Lead_Status,Lead_Source',
};

/**
 * Trae el registro dueño de cada conversacion, para poder decir en la alerta
 * quien es y de quien es la cuenta. Solo se llama con los que ya pasaron el
 * filtro, asi que son pocos: 1 llamada por modulo, no 1 por persona.
 */
export async function fichas(remitentes) {
  const porModulo = {};
  for (const s of remitentes) {
    const m = s?.module?.api_name;
    if (!m || !CAMPOS_POR_MODULO[m] || !s.id) continue;
    (porModulo[m] ||= new Set()).add(s.id);
  }
  const fichas = {};
  for (const [modulo, ids] of Object.entries(porModulo)) {
    const lista = [...ids];
    for (let i = 0; i < lista.length; i += 100) {
      const tanda = lista.slice(i, i + 100);
      const j = await get(`${modulo}?fields=${CAMPOS_POR_MODULO[modulo]}&ids=${tanda.join(',')}`);
      for (const r of j.data || []) fichas[`${modulo}:${r.id}`] = { ...r, modulo };
    }
  }
  return fichas;
}

/**
 * Como esta hoy el registro de una persona que quedo en seguimiento.
 * Sirve para saber si la venta se cerro de verdad, sin depender de que alguien
 * se acuerde de marcarla.
 *
 *  - Contacto: si aparecio un trato NUEVO despues de que abrimos el seguimiento,
 *    la venta existe y el seguimiento se cierra.
 *  - Lead: si cambio el Lead_Status respecto de cuando lo abrimos, alguien lo
 *    trabajo. No es tan fuerte como un trato, pero es la unica señal que da un
 *    lead sin convertir.
 */
export async function comoEsta({ modulo, id }) {
  if (!modulo || !id) return null;
  try {
    if (modulo === 'Contacts') {
      const j = await get(`Contacts/${id}/Deals?fields=id,Deal_Name,Stage,Amount,Created_Time&per_page=50`);
      return {
        modulo,
        tratos: (j.data || []).map((d) => ({
          id: d.id,
          nombre: d.Deal_Name,
          etapa: d.Stage,
          monto: d.Amount,
          creado: d.Created_Time,
        })),
      };
    }
    const j = await get(`Leads/${id}?fields=id,Full_Name,Lead_Status`);
    const r = (j.data || [])[0];
    return r ? { modulo, estadoLead: r.Lead_Status } : null;
  } catch {
    return null;
  }
}

/** Tratos abiertos de una cuenta o contacto, para saber si la venta ya existe. */
export async function tratosDeContactos(idsContacto) {
  if (!idsContacto.length) return {};
  const porContacto = {};
  for (const id of idsContacto) {
    try {
      const j = await get(`Contacts/${id}/Deals?fields=id,Deal_Name,Stage,Amount,Closing_Date&per_page=50`);
      porContacto[id] = (j.data || []).map((d) => ({
        id: d.id,
        nombre: d.Deal_Name,
        etapa: d.Stage,
        monto: d.Amount,
      }));
    } catch {
      porContacto[id] = [];
    }
  }
  return porContacto;
}
