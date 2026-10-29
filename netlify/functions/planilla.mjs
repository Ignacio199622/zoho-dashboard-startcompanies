/*
 * planilla.mjs — el Excel de renovaciones, en vivo desde el CRM.
 *
 * POR QUE EXISTE: el equipo trabaja en un Excel porque la lista de Zoho no
 * muestra los tres carriles (federal / estatal / R.A.) a la vez ni el estado de
 * la LLC, que vive en otro modulo. Una fase de Zoho tiene un solo valor; los
 * carriles pasan en paralelo. Esto arma la misma planilla leyendo el CRM y deja
 * editarla ahi mismo. El dato siempre vive en Zoho: esto es solo la ventana.
 *
 * CUBRE LOS PROCESOS DEL EXCEL:
 *   Renovación / Apertura / Cuenta Bancaria  -> modulo Tratos, separados por Type
 *   Pedidos de EIN                            -> modulo propio (si ya se creo)
 *
 * JUNTA DOS MODULOS, porque el dato esta partido:
 *   Tratos -> carriles, paquete, pago, importe, fase
 *   LLCs   -> estado (NM/WY/...), socio, fechas de renovacion
 *
 * ESCRIBIR ACA ES SEGURO, y se verifico antes de habilitarlo: Tratos tiene 0
 * blueprints y sus 5 reglas de flujo estan TODAS apagadas. Las 56 que mandan
 * WhatsApp viven en Posibles clientes. Ademas hay tres frenos:
 *
 *   1. Solo se pueden tocar los campos de EDITABLES. Nada mas.
 *   2. El valor tiene que ser uno de los permitidos para ese campo.
 *   3. Antes de escribir se relee el registro y se corta si no es del tipo que
 *      esa pestaña dice estar mostrando.
 *
 * Leer y escribir piden rol "equipo": es trabajo operativo, no informacion de
 * plata. Los tres frenos son los que cuidan.
 */
import auth from '../lib/auth.js';
import { filasEstatales } from './lib/estatales.js';

const { cabeceras, exigirAuth } = auth;

const SI_NO_NC = ['Sí', 'No', 'No corresponde'];
const SI_NO = ['Sí', 'No'];

// ---------- que se puede editar, por pestaña ----------
const EDITABLES_TRATO = {
  Renovaci_n_federal: SI_NO_NC,
  Renovaci_n_estatal: SI_NO_NC,
  Renovaci_n_R_A: SI_NO_NC,
  Avisado_al_cliente_o_partner: SI_NO,
  Enviado_al_liquidador: SI_NO_NC,
  Posibilidad_de_multa: SI_NO,
  Paquete: ['Emprendedor', 'Elite', 'Renovación', 'Renovación + Impuestos', 'Banco', 'Cierre'],
  Origen_del_trato: ['Start Companies', 'Transición de otro proveedor', 'Partner'],
  Vto_Annual_Report: null,   // null = campo de fecha
};
const EDITABLES_EIN = {
  Confirmado: ['Confirmado', 'Sin confirmar'],
  Pago: ['Pagado', 'Impago'],
  Entregado: ['Entregado', 'Pendiente'],
};

const TIPOS_TRATO = { 'Renovación': 1, 'Apertura': 1, 'Cuenta Bancaria': 1 };

// Pestaña Estatales: una fila por LLC, el tilde se guarda en la LLC (y en el
// trato de renovacion si es el ciclo 2026). Ver lib/estatales.js.
const MARCAS_ESTATAL = ['Presentada', 'No nos toca'];

const CAMPOS_TRATO = [
  'id', 'Deal_Name', 'Account_Name', 'Contact_Name', 'Type', 'Stage', 'Amount', 'Owner',
  'Partner', 'Estructura_Societaria', 'Medios_de_pago', 'Pago',
  'Fecha_de_renovacion', 'Fecha_de_constituci_n', 'Created_Time',
  ...Object.keys(EDITABLES_TRATO),
].join(',');

const CAMPOS_LLC = [
  'id', 'Account_Name', 'Estado_de_Registro', 'Estado_de_constituci_n', 'Estructura_Societaria',
  'Socio', 'Nombre_de_Partner', 'Fecha_renovaci_n_federal', 'Fecha_renovaci_n_estatal',
  'Correo_electr_nico', 'Phone', 'Fecha_de_Constituci_n', 'ltima_renovaci_n_estatal', 'Status',
].join(',');

const CAMPOS_EIN = ['id', 'Name', 'Titular', 'Nacionalidad', 'Estado', 'Estructura',
  'Cantidad_de_socios', 'Actividad', 'Fecha_del_pedido', 'Domicilio',
  'Confirmado', 'Pago', 'Entregado', 'Responsable', 'Owner'].join(',');

// ---------- Zoho ----------
let tokenCache = null;

async function token() {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.v;
  const p = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const j = await (await fetch(`https://accounts.zoho.com/oauth/v2/token?${p}`, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho no devolvió token');
  tokenCache = { v: j.access_token, exp: Date.now() + 55 * 60 * 1000 };
  return j.access_token;
}

async function zoho(path, opciones = {}) {
  const t = await token();
  const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, {
    ...opciones,
    headers: {
      Authorization: `Zoho-oauthtoken ${t}`,
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (r.status === 204) return {};
  const j = await r.json();
  if (j.status === 'error') throw new Error(`${path}: ${j.code} ${j.message}`);
  return j;
}

// El paginado del CRM va por page_token; sin eso corta en 2000.
async function paginado(modulo, campos, tope = 20) {
  const out = [];
  let pageToken = null;
  for (let i = 0; i < tope; i++) {
    const base = `${modulo}?fields=${campos}&per_page=200`;
    const j = await zoho(pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : base);
    out.push(...(j.data || []));
    if (!j.info?.more_records || !j.info?.next_page_token) break;
    pageToken = j.info.next_page_token;
  }
  return out;
}

// El modulo de EIN puede no existir todavia: entonces la pestaña no aparece.
let einCache = null;
async function moduloEin() {
  if (einCache !== null) return einCache;
  try {
    const j = await zoho('settings/modules');
    const m = (j.modules || []).find((x) => /pedidos de ein/i.test(`${x.plural_label || ''} ${x.api_name || ''}`));
    einCache = m ? m.api_name : false;
  } catch { einCache = false; }
  return einCache;
}

// ---------- armado ----------
const txt = (v) => (v === null || v === undefined ? '' : String(v));
const nombre = (v) => (v && typeof v === 'object' ? txt(v.name) : txt(v));

function filaTrato(d, llcsPorId) {
  const llc = d.Account_Name?.id ? llcsPorId.get(d.Account_Name.id) : null;
  return {
    id: d.id,
    llc: nombre(d.Account_Name) || txt(d.Deal_Name),
    titular: nombre(d.Contact_Name),
    estado: txt(llc?.Estado_de_Registro) || txt(llc?.Estado_de_constituci_n),
    socio: nombre(llc?.Socio) || txt(llc?.Nombre_de_Partner) || txt(d.Partner),
    estructura: txt(d.Estructura_Societaria) || txt(llc?.Estructura_Societaria),
    importe: d.Amount ?? null,
    fase: txt(d.Stage),
    duenio: nombre(d.Owner),
    mail: txt(llc?.Correo_electr_nico),
    medios: Array.isArray(d.Medios_de_pago) ? d.Medios_de_pago.join(', ') : txt(d.Medios_de_pago),
    pago: txt(d.Pago),
    vtoFederal: txt(llc?.Fecha_renovaci_n_federal),
    vtoEstatal: txt(llc?.Fecha_renovaci_n_estatal),
    federal: txt(d.Renovaci_n_federal),
    estatal: txt(d.Renovaci_n_estatal),
    ra: txt(d.Renovaci_n_R_A),
    avisado: txt(d.Avisado_al_cliente_o_partner),
    liquidador: txt(d.Enviado_al_liquidador),
    multa: txt(d.Posibilidad_de_multa),
    paquete: txt(d.Paquete),
    origen: txt(d.Origen_del_trato),
    vtoAnnual: txt(d.Vto_Annual_Report),
  };
}

const filaEin = (d) => ({
  id: d.id,
  llc: txt(d.Name),
  titular: txt(d.Titular),
  nacionalidad: txt(d.Nacionalidad),
  estado: txt(d.Estado),
  estructura: txt(d.Estructura),
  socios: d.Cantidad_de_socios ?? null,
  actividad: txt(d.Actividad),
  fecha: txt(d.Fecha_del_pedido),
  domicilio: txt(d.Domicilio),
  responsable: txt(d.Responsable) || nombre(d.Owner),
  confirmado: txt(d.Confirmado),
  pago: txt(d.Pago),
  entregado: txt(d.Entregado),
});

// Cache por instancia y por pestaña: el CRM tarda ~4s y esto se refresca a mano.
const cache = new Map();
const CACHE_MS = 3 * 60 * 1000;

async function leer(tipo) {
  const guardado = cache.get(tipo);
  if (guardado && Date.now() < guardado.exp) return guardado.datos;

  let datos;
  if (tipo === 'Estatal') {
    const [tratos, llcs] = await Promise.all([
      paginado('Deals', CAMPOS_TRATO),
      paginado('Accounts', CAMPOS_LLC),
    ]);
    const filas = filasEstatales(llcs, tratos);
    datos = { tipo, total: filas.length, filas, editables: { marca: MARCAS_ESTATAL } };
  } else if (tipo === 'EIN') {
    const api = await moduloEin();
    if (!api) throw new Error('todavía no existe el módulo "Pedidos de EIN"');
    const filas = (await paginado(api, CAMPOS_EIN)).map(filaEin);
    datos = { tipo, total: filas.length, filas, editables: EDITABLES_EIN };
  } else {
    const [tratos, llcs] = await Promise.all([
      paginado('Deals', CAMPOS_TRATO),
      paginado('Accounts', CAMPOS_LLC),
    ]);
    const llcsPorId = new Map(llcs.map((a) => [a.id, a]));
    const filas = tratos.filter((d) => d.Type === tipo).map((d) => filaTrato(d, llcsPorId));
    datos = { tipo, total: filas.length, tratosEnElCrm: tratos.length, filas, editables: EDITABLES_TRATO };
  }
  datos.generado = new Date().toISOString();
  datos.hayEin = Boolean(await moduloEin());
  cache.set(tipo, { datos, exp: Date.now() + CACHE_MS });
  return datos;
}

// ---------- handler ----------
function objetoDeHeaders(req) {
  const out = {};
  req.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers });

export default async (req) => {
  const h = objetoDeHeaders(req);
  const cab = cabeceras(h);
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cab });

  const falla = exigirAuth(h, cab, 'equipo');
  if (falla) return json(JSON.parse(falla.body), falla.statusCode, cab);

  // ----- leer -----
  if (req.method === 'GET') {
    const tipo = new URL(req.url).searchParams.get('tipo') || 'Renovación';
    if (tipo !== 'EIN' && tipo !== 'Estatal' && !TIPOS_TRATO[tipo]) return json({ error: 'Pestaña desconocida' }, 400, cab);
    try {
      return json(await leer(tipo), 200, cab);
    } catch (e) {
      return json({ error: 'No pude leer el CRM: ' + e.message }, 502, cab);
    }
  }

  // ----- escribir -----
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405, cab);

  let body = {};
  try { body = await req.json(); } catch { /* queda vacío */ }
  const { id, campo, valor, tipo } = body;
  if (!id || !campo) return json({ error: 'Falta el registro o el campo' }, 400, cab);

  if (tipo === 'Estatal') return marcarEstatal(body, cab);

  const esEin = tipo === 'EIN';
  if (!esEin && !TIPOS_TRATO[tipo]) return json({ error: 'Pestaña desconocida' }, 400, cab);
  const editables = esEin ? EDITABLES_EIN : EDITABLES_TRATO;

  // FRENO 1: solo los campos de la planilla.
  if (!Object.prototype.hasOwnProperty.call(editables, campo)) {
    return json({ error: `El campo "${campo}" no se puede editar desde la planilla` }, 403, cab);
  }

  // FRENO 2: el valor tiene que ser uno de los validos (o vacio, para borrar).
  const permitidos = editables[campo];
  const v = valor === null || valor === undefined ? '' : String(valor);
  if (v !== '' && permitidos && !permitidos.includes(v)) {
    return json({ error: `"${v}" no es un valor válido para ${campo}` }, 400, cab);
  }
  if (v !== '' && !permitidos && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return json({ error: 'La fecha tiene que ser AAAA-MM-DD' }, 400, cab);
  }

  try {
    const modulo = esEin ? await moduloEin() : 'Deals';
    if (!modulo) return json({ error: 'Todavía no existe el módulo "Pedidos de EIN"' }, 409, cab);

    // FRENO 3: se relee el registro y se corta si no es de la pestaña que dice serlo.
    const extra = esEin ? 'Name' : 'Type';
    const actual = await zoho(`${modulo}/${encodeURIComponent(id)}?fields=id,${extra},${campo}`);
    const reg = (actual.data || [])[0];
    if (!reg) return json({ error: 'Ese registro no existe' }, 404, cab);
    if (!esEin && reg.Type !== tipo) {
      return json({ error: `Este trato es "${reg.Type || 'sin tipo'}", no "${tipo}"` }, 403, cab);
    }

    const r = await zoho(modulo, {
      method: 'PUT',
      body: JSON.stringify({ data: [{ id, [campo]: v === '' ? null : v }], trigger: [] }),
    });
    const d = (r.data || [])[0] || {};
    if (d.status !== 'success') {
      return json({ error: `Zoho rechazó el cambio: ${d.code || ''} ${d.message || ''}` }, 502, cab);
    }

    cache.delete(tipo);   // la próxima lectura de esa pestaña trae el dato nuevo
    return json({ ok: true, id, campo, valor: v, antes: txt(reg[campo]) }, 200, cab);
  } catch (e) {
    return json({ error: 'No pude escribir en el CRM: ' + e.message }, 502, cab);
  }
};

// Tilde de la pestaña Estatales. Escribe la fecha de hoy (hora Argentina) en la
// LLC y, si hay trato de renovacion y es el ciclo 2026, el carril estatal del
// trato. Las dos con trigger: [] (en LLCs hay reglas create_or_edit, y una manda
// mensajes). Despues relee la LLC: Zoho contesta SUCCESS aunque no entre.
async function marcarEstatal({ id, valor, tratoId, anio }, cab) {
  if (!id || !MARCAS_ESTATAL.includes(valor)) return json({ error: 'Marca no válida' }, 400, cab);
  try {
    const actual = ((await zoho(`Accounts/${encodeURIComponent(id)}?fields=id,Account_Name`)).data || [])[0];
    if (!actual) return json({ error: 'Esa LLC no existe' }, 404, cab);
    const hoy = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

    const r = await zoho('Accounts', { method: 'PUT', body: JSON.stringify({ data: [{ id, ltima_renovaci_n_estatal: hoy }], trigger: [] }) });
    if ((r.data || [])[0]?.status !== 'success') return json({ error: 'Zoho rechazó el cambio en la LLC' }, 502, cab);

    if (tratoId && Number(anio) === 2026) {
      const t = ((await zoho(`Deals/${encodeURIComponent(tratoId)}?fields=id,Type,Account_Name`)).data || [])[0];
      if (t && t.Type === 'Renovación' && t.Account_Name?.id === id) {
        await zoho('Deals', { method: 'PUT', body: JSON.stringify({ data: [{ id: tratoId, Renovaci_n_estatal: valor === 'Presentada' ? 'Sí' : 'No corresponde' }], trigger: [] }) });
      }
    }

    const leida = ((await zoho(`Accounts/${encodeURIComponent(id)}?fields=id,ltima_renovaci_n_estatal`)).data || [])[0];
    if (leida?.ltima_renovaci_n_estatal !== hoy) return json({ error: 'Zoho dijo que sí pero la fecha no quedó: avisá' }, 502, cab);

    cache.delete('Estatal');
    return json({ ok: true, id, valor, fecha: hoy }, 200, cab);
  } catch (e) {
    return json({ error: 'No pude escribir en el CRM: ' + e.message }, 502, cab);
  }
}
