/*
 * Le manda a Meta la VENTA con su importe, cuando un trato de Meta se vende.
 *
 * POR QUE EXISTE, Y POR QUE NO ES UNA CADENA DE LEADCHAIN.
 * Se probo la ruta facil primero: una cadena de LeadChain con origen Tratos
 * (chain 20). Anda, pero solo dispara cuando el trato PASA por Filing Iniciado
 * y solo si trae cookie de Meta; no lleva event_id (CHIVA PIANNO llego dos
 * veces con USD 600) y cada candado nuevo cuesta una noche en el editor de
 * formulas de Zoho. Esto mira el estado cada hora, decide con la Fuente ademas
 * de la cookie, deduplica por trato y deja escrito por que hizo cada cosa.
 * Desde el 19-sep-2026 es el UNICO cano de la venta con importe: la cadena 20
 * queda inactiva para no duplicar.
 *
 * QUE MANDA
 *   event_name  Purchase
 *   event_id    trato-<id> -> Meta deduplica solo si algo lo reenvia
 *   value       el Importe del trato, en USD
 *   user_data   mail y telefono del Contacto, hasheados en SHA-256, + _fbc y
 *               lead_id de Meta cuando existen
 *
 * QUE CUENTA COMO VENDIDO. No la fase final: la primera fase que ya implica
 * que se pago. En Aperturas es `Filing Iniciado` (la regla de validacion de
 * Zoho exige el Importe para llegar ahi), y todo lo que viene despues. Asi la
 * venta sale dentro de la ventana de 7 dias de Meta, y no cuando la LLC termina
 * el banco tres semanas mas tarde. Como cada trato se manda UNA vez, pasar por
 * las fases siguientes no lo repite.
 *
 * LOS CANDADOS (los mismos que la cadena 20, mas dos), en este orden:
 *   1. Origen Meta: identidad dura (Social Lead ID, _fbc, fbclid) O Fuente del
 *      trato o del contacto que diga Meta / Facebook / Instagram. La cookie sola
 *      perdia las ventas que agendan sin cookie (BestJobReview, Nexus Core).
 *   2. Sin Partner: una venta por socio no es pauta.
 *   3. Trato creado hace 15 dias o menos. Bloquea las cargas retroactivas y deja
 *      pasar los ciclos largos (medido: 0 de 43 ventas tardaron mas de 15 dias
 *      entre crear el trato y Filing; la mas lenta 8,2).
 *   4. Nada que haya nacido en lote: sin Tipo, o mas de LOTE_MAX tratos creados
 *      por la misma persona en la misma hora. La planilla de Pablo del 8/9-sep
 *      metio 65 ventas viejas como si fueran de la semana; no vuelve a pasar.
 *   5. Importe > 0 y una identidad para matchear (mail o telefono del contacto,
 *      o lead_id). Si falta, NO se descarta: se reintenta hasta 7 dias, porque
 *      el importe y el contacto muchas veces se cargan despues.
 *
 * MEMORIA. Zoho no tiene una fecha confiable de "cuando se vendio"
 * (`Stage_Modified_Time` vacio en el 100%, `Modified_Time` pisado por las
 * ediciones masivas), asi que el agente lleva la suya en blobs:
 *   conocidos   ids ya resueltos (mandados o descartados en firme). Antes se
 *               marcaba conocido TODO lo visto, incluso lo que supero el tope
 *               por corrida o lo que estaba sin importe, y esas ventas se
 *               perdian para siempre (45 en septiembre). Ya no.
 *   pendientes  id -> primera vez visto, para los que faltan importe o contacto.
 *   enviados    ids que ya salieron a Meta.
 *   descartes   los ultimos descartes con su motivo, para auditar.
 *   bitacora    resumen de cada corrida.
 *
 * FRENOS:
 *   0. SIMULA POR DEFECTO. Sin META_CAPI_TOKEN y sin VENTA_META_APLICAR=1 no
 *      manda nada: calcula, escribe la bitacora y devuelve lo que HARIA.
 *   1. `?seco=1` en la URL: calcula y devuelve, sin mandar y sin tocar blobs.
 *   2. La primera corrida NUNCA manda: solo fija la linea de base.
 *   3. Un trato se manda UNA vez. Tope por corrida.
 *   4. Interruptor: si existe el blob `venta-meta-apagado`, no manda nada.
 *   5. Nunca escribe en Zoho. Solo lee.
 */
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const ZOHO = 'https://www.zohoapis.com/crm/v6';
const PIXEL = '3246575845534868';           // Start Companies, el pixel nuevo
const GRAPH = 'https://graph.facebook.com/v21.0';

const MAX_POR_CORRIDA = 25;
const DIAS_TRATO = 15;                       // candado 3: edad maxima del trato
const DIAS_REINTENTO = 7;                    // candado 5: cuanto se espera el importe/contacto
const LOTE_MAX = 15;                         // candado 4: mas que esto en una hora = carga en lote
const MAX_BITACORA = 40;
const MAX_DESCARTES = 300;

// Fases que ya implican que se pago. Por nombre VISIBLE y por el interno,
// porque en este CRM no coinciden (`Apertura Activa` es `Closed Won`,
// `Cuenta Bancaria Finalizada` es `Relay Finalizado`, etc.) y segun por donde
// entre el dato la API devuelve uno u otro.
const VENDIDAS = new Set([
  // Aperturas: desde Filing en adelante
  'Filing Iniciado', 'Needs Analysis',
  'Documentación completada', 'Documentacion completada',
  'Apertura Cuenta Bancaria',
  'Cuenta Bancaria Confirmada', 'Negotiation/Review',
  'Apertura Activa', 'Closed Won',
  // Renovaciones
  'Renovación completa', 'Renovacion completa',
  // Cuentas bancarias (diseño propio: la fase lleva punto)
  'Cuenta Bancaria Confirmada.',
  'Cuenta Bancaria Finalizada', 'Relay Finalizado',
]);

const ES_META = /meta|facebook|instagram/i;
const t = (v) => v !== null && v !== undefined && String(v).trim() !== '';

const sha = (v) => createHash('sha256').update(String(v)).digest('hex');

/** Meta pide el mail en minuscula y sin espacios, y el telefono solo digitos. */
const hashMail = (m) => {
  const v = String(m || '').trim().toLowerCase();
  return /.+@.+\..+/.test(v) ? sha(v) : null;
};
const hashTel = (tel) => {
  const v = String(tel || '').replace(/\D/g, '');
  return v.length >= 8 ? sha(v) : null;
};

let tokenCache = null;
async function tokenZoho(env) {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.v;
  const p = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const j = await (await fetch(`https://accounts.zoho.com/oauth/v2/token?${p}`, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho no devolvio token');
  tokenCache = { v: j.access_token, exp: Date.now() + 55 * 60 * 1000 };
  return j.access_token;
}

async function zoho(path, token) {
  const r = await fetch(`${ZOHO}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (r.status === 204) return {};
  return r.json();
}

export const CAMPOS_TRATO = [
  'id', 'Deal_Name', 'Type', 'Stage', 'Amount', 'Contact_Name', 'Partner',
  'Lead_Source', 'Created_Time', 'Modified_Time', 'Created_By',
  'fbc', 'fbclid', 'leadchain0__Social_Lead_ID',
].join(',');

/**
 * Los tratos en fase de vendido. Se leen los mas nuevos primero y se corta
 * cuando ya son mas viejos que la ventana: lo anterior no puede pasar el
 * candado 3, asi que no hace falta traerlo.
 */
export async function tratosVendidos(token, ahora = new Date()) {
  const piso = new Date(ahora.getTime() - (DIAS_TRATO + 1) * 86400e3).toISOString();
  const out = [];
  let page = 1;
  for (let i = 0; i < 12; i++) {
    const j = await zoho(`Deals?fields=${CAMPOS_TRATO}&sort_by=Created_Time&sort_order=desc&per_page=200&page=${page}`, token);
    const lote = j.data || [];
    out.push(...lote);
    if (!j.info?.more_records || lote.some((d) => d.Created_Time < piso)) break;
    page++;
  }
  return out.filter((d) => VENDIDAS.has(d.Stage));
}

/** El mail y el telefono salen del Contacto vinculado, no del trato. */
export async function datosDelContacto(id, token) {
  if (!id) return {};
  // Desde el 22-sep el agente de origen deja en la ficha del cliente lo que
  // antes moria al convertir: _fbp, la ip y el userAgent con los que entro. Son
  // tres parametros mas de matching para Meta, y estaban tirados.
  const j = await zoho(`Contacts/${id}?fields=Email,Mobile,Phone,First_Name,Last_Name,Lead_Source,fbp,fbc,ip,userAgent`, token);
  return (j.data || [])[0] || {};
}

/**
 * Cuantos tratos creo la misma persona en la misma hora que cada uno (candado
 * 4). Por persona y no solo por hora: el 8-sep Pablo cargo 16 renovaciones de
 * la planilla a las 15h y en esa misma hora Staff creo Towers Growth, una
 * venta real de Meta. Por hora sola, Towers caia como lote.
 */
export function tamanoDeLote(tratos) {
  const clave = (d) => `${d.Created_By?.id || d.Created_By?.name || '?'}|${String(d.Created_Time || '').slice(0, 13)}`;
  const porClave = {};
  for (const d of tratos) porClave[clave(d)] = (porClave[clave(d)] || 0) + 1;
  return (d) => porClave[clave(d)] || 0;
}

const identidadDura = (d) => t(d.leadchain0__Social_Lead_ID) || t(d.fbc) || t(d.fbclid);

/**
 * Decide que hacer con un trato. Devuelve
 *   { accion: 'enviar', evento }
 *   { accion: 'descartar', motivo }        en firme: no se vuelve a mirar
 *   { accion: 'esperar', motivo }          falta algo que puede aparecer
 * Pura salvo por `contacto`, que ya viene leido. Es lo que prueba el seco.
 */
export function evaluar(trato, contacto, { ahora = new Date(), enLote = 0 } = {}) {
  const creado = new Date(trato.Created_Time);
  const edadDias = (ahora - creado) / 86400e3;

  // 4. Lote: sin Tipo, o demasiados en la misma hora.
  if (!t(trato.Type)) return { accion: 'descartar', motivo: 'sin tipo (carga en lote)' };
  if (enLote > LOTE_MAX) return { accion: 'descartar', motivo: `carga en lote (${enLote} tratos en la misma hora)` };

  // 3. Edad del trato.
  if (!(edadDias <= DIAS_TRATO)) return { accion: 'descartar', motivo: `trato de ${Math.round(edadDias)} dias` };

  // 2. Partner.
  if (trato.Partner && (trato.Partner.id || trato.Partner.name)) {
    return { accion: 'descartar', motivo: `venta por socio (${trato.Partner.name || 'partner'})` };
  }

  // 1. Origen Meta: cookie o Fuente (del trato o del contacto). Una fuente
  // vacia no es un "no": los tratos nuevos nacen sin Fuente y la regla de
  // atribucion la copia despues del lead. Se espera, como al importe.
  const fuente = [trato.Lead_Source, contacto?.Lead_Source].filter(t).join(' / ');
  const deMeta = identidadDura(trato) || ES_META.test(fuente);
  if (!deMeta && !fuente) return { accion: 'esperar', motivo: 'sin fuente todavia' };
  if (!deMeta) return { accion: 'descartar', motivo: `no es de Meta (fuente: ${fuente})` };

  // 5. Importe e identidad para matchear. Faltantes que pueden llenarse: esperar.
  if (!(Number(trato.Amount) > 0)) return { accion: 'esperar', motivo: 'sin importe' };
  const evento = armarEvento(trato, contacto || {}, ahora);
  if (!matcheable(evento)) {
    return { accion: 'esperar', motivo: trato.Contact_Name?.id ? 'contacto sin mail ni telefono' : 'sin contacto vinculado' };
  }
  return { accion: 'enviar', evento };
}

function armarEvento(trato, contacto, ahora) {
  const em = hashMail(contacto.Email);
  const ph = hashTel(contacto.Mobile || contacto.Phone);
  const user_data = {};
  if (em) user_data.em = [em];
  if (ph) user_data.ph = [ph];
  if (contacto.First_Name) user_data.fn = [sha(String(contacto.First_Name).trim().toLowerCase())];
  if (contacto.Last_Name) user_data.ln = [sha(String(contacto.Last_Name).trim().toLowerCase())];
  // El _fbc y el _fbp del trato mandan; si el trato no los tiene, los de la
  // ficha del cliente (que es donde quedaron los del lead original).
  const fbc = t(trato.fbc) ? trato.fbc : contacto.fbc;
  if (t(fbc)) user_data.fbc = fbc;
  if (t(contacto.fbp)) user_data.fbp = contacto.fbp;
  // La ip y el navegador son los de cuando la persona dejo sus datos, no los de
  // este momento: para un evento de CRM es lo unico que hay y Meta los toma.
  if (t(contacto.ip)) user_data.client_ip_address = String(contacto.ip).trim();
  if (t(contacto.userAgent)) user_data.client_user_agent = String(contacto.userAgent).trim();
  if (t(trato.leadchain0__Social_Lead_ID)) user_data.lead_id = Number(trato.leadchain0__Social_Lead_ID);
  return {
    event_name: 'Purchase',
    // La hora de deteccion: corre cada hora y Zoho no guarda cuando se vendio.
    event_time: Math.floor(ahora.getTime() / 1000),
    event_id: `trato-${trato.id}`,          // idempotencia y deduplicacion
    action_source: 'system_generated',
    user_data,
    custom_data: { currency: 'USD', value: Number(trato.Amount) || 0 },
  };
}

/** Un evento sin ninguna llave de identidad no sirve: Meta no puede matchearlo. */
const matcheable = (e) => Boolean(e.user_data.em || e.user_data.ph || e.user_data.lead_id);

const leerJson = async (store, k, def) => JSON.parse((await store.get(k)) || JSON.stringify(def));

export default async (req) => {
  const env = process.env;
  const seco = (() => { try { return new URL(req.url).searchParams.get('seco') === '1'; } catch { return false; } })();
  const store = getStore({ name: 'venta-meta', consistency: 'strong' });
  const ahora = new Date();

  const apagado = await store.get('venta-meta-apagado');
  if (apagado && !seco) return Response.json({ ok: true, apagado: true });

  const aplicar = env.VENTA_META_APLICAR === '1' && Boolean(env.META_CAPI_TOKEN) && !seco;
  const enviados = new Set(await leerJson(store, 'enviados', []));
  const previo = await store.get('conocidos');
  const conocidos = new Set(JSON.parse(previo || '[]'));
  const pendientes = await leerJson(store, 'pendientes', {});
  const descartes = await leerJson(store, 'descartes', []);

  const token = await tokenZoho(env);
  const tratos = await tratosVendidos(token, ahora);

  // Primera corrida: se fija la linea de base y no se manda nada. Sin esto, el
  // primer arranque mandaria de golpe todo lo vendido de los ultimos 15 dias.
  if ((previo === undefined || previo === null) && !seco) {
    await store.set('conocidos', JSON.stringify(tratos.map((d) => d.id)));
    return Response.json({
      corrida: ahora.toISOString(),
      modo: 'linea de base',
      vendidos_hoy: tratos.length,
      mandados: 0,
      nota: 'Primera corrida: se registro el estado actual. Desde ahora solo se mandan las ventas nuevas.',
    });
  }

  const enLote = tamanoDeLote(tratos);
  const nuevos = tratos.filter((d) => !conocidos.has(d.id) && !enviados.has(d.id));
  const listos = [];
  const resueltos = [];     // { id, nombre, accion, motivo } de esta corrida
  const espera = [];

  for (const d of nuevos) {
    const contacto = await datosDelContacto(d.Contact_Name?.id, token);
    const r = evaluar(d, contacto, { ahora, enLote: enLote(d) });
    if (r.accion === 'enviar') {
      if (listos.length < MAX_POR_CORRIDA) listos.push({ trato: d, evento: r.evento });
      // Si supero el tope, NO se marca conocido: la proxima corrida lo agarra.
      continue;
    }
    if (r.accion === 'descartar') {
      resueltos.push({ id: d.id, nombre: d.Deal_Name, usd: Number(d.Amount) || 0, motivo: r.motivo, cuando: ahora.toISOString() });
      continue;
    }
    // esperar: se anota la primera vez que se lo vio, y se suelta a los 7 dias.
    const desde = pendientes[d.id] || ahora.toISOString();
    const diasEsperando = (ahora - new Date(desde)) / 86400e3;
    if (diasEsperando > DIAS_REINTENTO) {
      resueltos.push({ id: d.id, nombre: d.Deal_Name, usd: Number(d.Amount) || 0, motivo: `${r.motivo} durante ${DIAS_REINTENTO} dias (vencido)`, cuando: ahora.toISOString() });
      delete pendientes[d.id];
    } else {
      pendientes[d.id] = desde;
      espera.push({ nombre: d.Deal_Name, motivo: r.motivo, desde });
    }
  }

  // Salud del token. El 22-sep se le piso el token a un cano que funcionaba y no
  // habia forma de saber si el nuevo servia hasta que se perdiera una venta: una
  // venta se manda una sola vez. Esto es una lectura del dataset (no escribe
  // nada) y deja el resultado en la bitacora de cada corrida.
  let token_ok = null;
  if (aplicar) {
    try {
      // Se prueba ESCRIBIR, que es lo unico que importa acá, con la lista de
      // eventos vacia: no manda ninguna compra. Leer la ficha del dataset no
      // sirve de chequeo: un token de CAPI escribe eventos y no puede leerla
      // (da "(#100) Missing Permission" siendo un token perfectamente bueno).
      const r = await fetch(`${GRAPH}/${PIXEL}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [], access_token: env.META_CAPI_TOKEN }),
      });
      const j = await r.json();
      const sinPermiso = j.error && !/data\[0\]|param data|must be|empty/i.test(j.error.message || '');
      token_ok = r.ok || !sinPermiso ? true : `NO SIRVE: ${j.error?.message || `HTTP ${r.status}`}`;
    } catch (e) {
      token_ok = `no se pudo chequear: ${e.message}`;
    }
  }

  let mandados = 0;
  const errores = [];
  if (aplicar && listos.length) {
    const r = await fetch(`${GRAPH}/${PIXEL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: listos.map((x) => x.evento), access_token: env.META_CAPI_TOKEN }),
    });
    const j = await r.json();
    if (r.ok && !j.error) {
      mandados = j.events_received ?? listos.length;
      for (const x of listos) enviados.add(x.trato.id);
    } else {
      errores.push(j.error?.message || `HTTP ${r.status}`);
    }
  }

  const resumen = {
    corrida: ahora.toISOString(),
    modo: seco ? 'seco' : aplicar ? 'enviando' : 'simulacion',
    token_ok,
    vendidos_hoy: tratos.length,
    nuevos: nuevos.length,
    listos_para_enviar: listos.map((x) => ({ nombre: x.trato.Deal_Name, usd: Number(x.trato.Amount) || 0, con: Object.keys(x.evento.user_data).join('+') })),
    mandados,
    descartados: resueltos.map((x) => `${x.nombre}: ${x.motivo}`),
    esperando: espera,
    valor_usd: listos.reduce((a, x) => a + (Number(x.trato.Amount) || 0), 0),
    errores,
  };
  if (seco) return Response.json(resumen);

  // Conocido = resuelto en firme: lo mandado y lo descartado. Lo que espera y lo
  // que supero el tope quedan afuera a proposito, para volver a mirarlos.
  for (const x of resueltos) conocidos.add(x.id);
  if (!errores.length) for (const x of listos) conocidos.add(x.trato.id);
  for (const x of listos) delete pendientes[x.trato.id];
  for (const x of resueltos) delete pendientes[x.id];

  await store.set('enviados', JSON.stringify([...enviados].slice(-2000)));
  await store.set('conocidos', JSON.stringify([...conocidos].slice(-5000)));
  await store.set('pendientes', JSON.stringify(pendientes));
  await store.set('descartes', JSON.stringify([...resueltos, ...descartes].slice(0, MAX_DESCARTES)));
  const bitacora = await leerJson(store, 'bitacora', []);
  bitacora.unshift(resumen);
  await store.set('bitacora', JSON.stringify(bitacora.slice(0, MAX_BITACORA)));

  return Response.json(resumen);
};

// A y cuarenta y cinco: agente-llamadas corre en punto, canal-leads y cuarto,
// el coach y media. Que no se pisen.
export const config = { schedule: '45 * * * *' };
