/*
 * Crea y actualiza el lead en Zoho desde el embudo de ManyChat (@ignacio.llc).
 *
 * POR QUE EXISTE ESTA FUNCION Y NO UN WEBHOOK DIRECTO
 * ManyChat no sabe hacer el refresh de OAuth de Zoho: solo manda un POST con
 * un header fijo. Esta funcion es el puente. ManyChat pega aca, aca se pide el
 * token con el refresh que ya usan los demas agentes, y se escribe en el CRM.
 *
 * COMO SE USA DESDE MANYCHAT
 * Bloque "External Request" (Pro):
 *   POST https://<sitio>.netlify.app/.netlify/functions/manychat-lead
 *   Header: x-sc-secret: <MANYCHAT_SECRET>
 *   Body JSON con los campos de abajo. La respuesta trae { id }, que hay que
 *   guardar en el campo de usuario `zoho_lead_id` de ManyChat. En los envios
 *   siguientes se manda ese id y la funcion actualiza en vez de duplicar.
 *
 * TRES FRENOS, porque en este CRM escribir un lead puede mandarle un WhatsApp
 * al cliente:
 *   1. MODO SOMBRA. Con MANYCHAT_SOMBRA=1 no escribe nada: devuelve lo que
 *      habria hecho. Es como arranca, una semana, antes de conectarlo de verdad.
 *   2. NO se actualiza un lead que este dentro de un flujo de mensajes. Usa el
 *      mismo `seguroEditar` que ya frena al agente de canal.
 *   3. Lista blanca de campos. Solo se escriben los de ESCRIBIBLES. Cualquier
 *      otra cosa que mande ManyChat se ignora.
 *
 * LO QUE NO HACE A PROPOSITO
 *   - No pone `Lead_Status`. Las cadenas de mensajes se disparan por ese campo
 *     y por etiquetas de formularios de Meta. El lead entra sin estado y sin
 *     esas etiquetas, asi que no cae en ninguna cadencia existente. El
 *     seguimiento lo hace ManyChat, no Zoho, y no queremos los dos a la vez.
 *   - No toca `Phone`. En este CRM el telefono vive en `Mobile`.
 *
 * LA UNICA EXCEPCION: SOCIOS (13-sep-2026)
 *   Si `origen_entrada` contiene "socio" (el flujo "Comentarios SOCIO" de
 *   ManyChat), el lead SI entra con la etiqueta `Form Socios Meta` y con las
 *   reglas prendidas (trigger workflow). Es a proposito: esa etiqueta es la
 *   que dispara el ruteo de socios y la cadencia de 10 dias que administra
 *   Adrian, la misma que reciben los que llegan por el formulario de Meta.
 */
import { tokenZoho } from './lib/aprobacion.js';
import { seguroEditar, CAMPOS_SEGURIDAD } from './lib/seguridad-leads.js';

const API = 'https://www.zohoapis.com/crm/v6';

// Valores que YA existen en los picklists. Verificado contra el CRM el 7-sep-2026.
// Si se inventa uno nuevo, Zoho lo ignora en silencio y el campo queda vacio.
// 18-sep-2026 (normalizacion de origen): cada campo guarda lo que dice su nombre.
//   Lead_Source    = el CANAL (Marca Personal: es la cuenta de Ignacio)
//   Landing_Origen = la PAGINA por donde entro (el bot del DM de Instagram)
//   Calendario     = solo cuando reserva en Cal (lo llena calcom-agenda / el Flow)
const LEAD_SOURCE = 'Marca Personal';
const SLUG = 'ig-dm-ignacio';
// Etiqueta de la que cuelgan las 3 reglas de socios (id 6698625000057284089).
const TAG_SOCIOS = 'Form Socios Meta';
const esSocio = (b) => /socio/i.test(S(b.origen_entrada));

// Lista blanca. Nada fuera de esto se escribe, venga como venga en el body.
const ESCRIBIBLES = new Set([
  'Last_Name', 'First_Name', 'Mobile', 'Email',
  'Lead_Source', 'Landing_Origen', 'Calendario', 'Description', 'Tag',
]);

const S = (v) => (v == null ? '' : String(v).trim());

/*
 * ManyChat manda "Full Contact Data": el contacto entero, con sus nombres de
 * campo, no los mios. Se eligio asi porque escribir el JSON a mano no sirve:
 * las variables tipeadas como texto no las reconoce, hay que insertarlas una
 * por una con el selector. Full Contact Data es un click y manda todo.
 *
 * Esta funcion aplana las dos formas posibles a un solo objeto:
 *   - la de ManyChat: { first_name, last_name, ig_username, phone, id, custom_fields }
 *   - la mia, la de las pruebas por curl: { nombre, usuario_ig, wa_numero, ... }
 */
function normalizar(b) {
  if (!b || typeof b !== 'object') return {};
  // custom_fields llega como objeto {nombre: valor} o como lista [{name, value}]
  const cf = {};
  const raw = b.custom_fields;
  if (Array.isArray(raw)) for (const c of raw) { if (c && c.name) cf[c.name] = c.value; }
  else if (raw && typeof raw === 'object') Object.assign(cf, raw);

  const nombreManychat = [S(b.first_name), S(b.last_name)].filter(Boolean).join(' ') || S(b.name);

  return {
    nombre:         S(b.nombre) || extraerNombre(S(cf.wa_numero) || S(b.wa_numero), nombreManychat),
    usuario_ig:     S(b.usuario_ig) || S(b.ig_username),
    wa_numero:      S(b.wa_numero) || S(cf.wa_numero) || S(b.phone),
    email:          S(b.email) || S(cf.email),
    mc_id:          S(b.mc_id) || S(b.id) || S(b.key),
    zoho_lead_id:   S(b.zoho_lead_id) || S(cf.zoho_lead_id),
    nicho:          S(b.nicho) || S(cf.nicho),
    facturacion:    S(b.facturacion) || S(cf.facturacion),
    cobra_con:      S(b.cobra_con) || S(cf.cobra_con),
    urgencia:       S(b.urgencia) || S(cf.urgencia),
    que_lo_frena:   S(b.que_lo_frena) || S(cf.que_necesita),
    decide_con:     S(b.decide_con) || S(cf.decide_con),
    origen_entrada: S(b.origen_entrada) || S(cf.origen_entrada),
  };
}

/*
 * EL WHATSAPP VIENE COMO TEXTO LIBRE (14-sep-2026)
 * Antes el bloque de ManyChat era de tipo "Telefono" y validaba el solo: si la
 * persona escribia "Mi nombre es Icho y este es mi whatsapp +54938151628" lo
 * rechazaba dos veces con el aviso de formato y recien aceptaba el numero pelado.
 * Ahora el bloque es de texto libre (campo `wa_numero`) y el numero se saca aca.
 * Reglas: el primer tramo de 8 a 15 digitos (con espacios, guiones o parentesis
 * en el medio), "00" adelante vale como "+", y si viene sin "+" se le pone.
 * Si no hay numero, el lead entra igual sin Mobile: lo pide el vendedor.
 */
function extraerTelefono(texto) {
  const t = S(texto);
  if (!t) return '';
  // Tramos de digitos con separadores en el medio. Se queda con el mas largo.
  const tramos = t.match(/\+?\d[\d\s().-]{6,}\d/g) || [];
  let mejor = '';
  for (const tramo of tramos) {
    let d = tramo.replace(/[^\d+]/g, '');
    if (d.startsWith('00')) d = '+' + d.slice(2);
    const digitos = d.replace(/\D/g, '');
    if (digitos.length < 8 || digitos.length > 15) continue;
    if (digitos.length > mejor.replace(/\D/g, '').length) mejor = d;
  }
  if (!mejor) return '';
  return mejor.startsWith('+') ? mejor : '+' + mejor;
}

/** Compatibilidad con las pruebas por curl que mandan el numero ya limpio. */
const normalizarTelefono = extraerTelefono;

/*
 * Si en el mismo mensaje se presento ("mi nombre es Icho", "soy Juan Perez",
 * "me llamo Ana"), ese nombre le gana al del perfil de Instagram, que muchas
 * veces es el de la marca o un apodo. Si dijo solo el nombre de pila y el perfil
 * ya empieza con ese mismo nombre, se queda el del perfil, que trae apellido.
 */
function extraerNombre(texto, nombrePerfil) {
  const t = S(texto);
  const m = t.match(/(?:mi nombre es|me llamo|soy|aqui|aca)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'.-]*(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'.-]*){0,3})/i);
  if (!m) return S(nombrePerfil);
  // Cortar en la primera palabra que ya no es nombre ("y", "este", "es", "mi", ...).
  const palabras = [];
  for (const w of m[1].split(/\s+/)) {
    if (/^(y|e|este|esta|es|mi|el|la|de|del|te|les|acá|aquí|aca|aqui|numero|número|whatsapp|wsp|wpp|tel|cel|celu)$/i.test(w)) break;
    palabras.push(w);
  }
  const nombre = palabras.join(' ');
  if (!nombre) return S(nombrePerfil);
  const perfil = S(nombrePerfil);
  if (palabras.length === 1 && perfil.split(/\s+/).length > 1 && perfil.toLowerCase().startsWith(nombre.toLowerCase())) return perfil;
  return nombre;
}

/** Las respuestas del embudo en una linea, que es lo que lee el vendedor antes de entrar. */
function armarDescripcion(b) {
  const partes = [
    ['Instagram', b.usuario_ig],
    ['Entro por', b.origen_entrada],
    ['Cobra con', b.cobra_con],
    ['Factura', b.facturacion],
    ['Rubro', b.nicho],
    ['Urgencia', b.urgencia],
    ['Lo frena', b.que_lo_frena],
    ['Decide con', b.decide_con],
    ['ManyChat id', b.mc_id],
  ].filter(([, v]) => S(v));
  if (!partes.length) return '';
  return 'Embudo ManyChat (@ignacio.llc)\n' + partes.map(([k, v]) => `${k}: ${S(v)}`).join('\n');
}

function armarCampos(b) {
  const nombre = S(b.nombre) || S(b.usuario_ig) || 'Lead DM';
  const trozos = nombre.split(/\s+/);
  const campos = {
    Last_Name: trozos.length > 1 ? trozos.slice(1).join(' ') : nombre,
    Lead_Source: LEAD_SOURCE,
    Landing_Origen: SLUG,
  };
  if (trozos.length > 1) campos.First_Name = trozos[0];

  const tel = normalizarTelefono(b.wa_numero);
  if (tel) campos.Mobile = tel;              // OJO: Mobile, nunca Phone.
  if (S(b.email)) campos.Email = S(b.email);

  const desc = armarDescripcion(b);
  if (desc) campos.Description = desc;

  if (esSocio(b)) campos.Tag = [{ name: TAG_SOCIOS }];

  return campos;
}

async function zoho(t, path, opts = {}) {
  const r = await fetch(`${API}/${path}`, {
    ...opts,
    headers: { Authorization: `Zoho-oauthtoken ${t}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 204) return { data: [] };
  return r.json();
}

export default async (req) => {
  const responder = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') return responder({ error: 'solo POST' }, 405);

  const secreto = process.env.MANYCHAT_SECRET;
  if (!secreto) return responder({ error: 'falta MANYCHAT_SECRET en el entorno' }, 500);
  if (req.headers.get('x-sc-secret') !== secreto) return responder({ error: 'secreto invalido' }, 401);

  let crudo;
  try { crudo = await req.json(); } catch { return responder({ error: 'body no es JSON' }, 400); }

  const b = normalizar(crudo);
  const campos = armarCampos(b);
  // `telefono` vuelve limpio (o vacio) para que ManyChat lo guarde y decida si repregunta.
  const telefono = campos.Mobile || '';
  const sombra = process.env.MANYCHAT_SOMBRA === '1';
  const idExistente = S(b.zoho_lead_id);

  if (sombra) {
    console.log('[manychat-lead][SOMBRA]', idExistente ? 'actualizaria' : 'crearia', JSON.stringify(campos));
    return responder({ ok: true, sombra: true, accion: idExistente ? 'update' : 'create', id: idExistente || 'sombra-sin-id', telefono, campos });
  }

  const t = await tokenZoho();

  // ---- ACTUALIZAR ----
  if (idExistente) {
    const actual = await zoho(t, `Leads/${idExistente}?fields=${CAMPOS_SEGURIDAD.join(',')}`);
    const lead = (actual.data || [])[0];
    if (!lead) return responder({ ok: false, error: 'el lead ya no existe', id: idExistente }, 404);

    // OJO: seguroEditar devuelve { seguro, motivos }, no un array. Si se lee
    // como array, `.length` da undefined y el freno no frena nunca.
    const s = seguroEditar(lead);
    if (!s.seguro) {
      // Esta dentro de un flujo que manda mensajes. No se toca.
      console.log('[manychat-lead] no se edita', idExistente, s.motivos.join(' | '));
      return responder({ ok: true, accion: 'omitido', id: idExistente, telefono, motivos: s.motivos });
    }

    const soloBlancos = Object.fromEntries(Object.entries(campos).filter(([k]) => ESCRIBIBLES.has(k)));
    // Al actualizar no se pisa el nombre ni el origen: ya quedaron del alta.
    delete soloBlancos.Last_Name; delete soloBlancos.First_Name;
    delete soloBlancos.Lead_Source; delete soloBlancos.Landing_Origen; delete soloBlancos.Calendario;

    if (!Object.keys(soloBlancos).length) return responder({ ok: true, accion: 'nada_que_actualizar', id: idExistente, telefono });

    const res = await zoho(t, `Leads/${idExistente}`, {
      method: 'PUT',
      body: JSON.stringify({ data: [soloBlancos], trigger: [] }), // trigger vacio: sin workflows
    });
    const fila = (res.data || [])[0] || {};
    return responder({ ok: fila.code === 'SUCCESS', accion: 'update', id: idExistente, telefono, zoho: fila, campos: soloBlancos });
  }

  // ---- CREAR ----
  // trigger vacio: sin workflows al alta. Socios es la excepcion: sus reglas
  // (ruteo + cadencia) tienen que correr, igual que con el formulario de Meta.
  const trigger = esSocio(b) ? ['workflow'] : [];
  const res = await zoho(t, 'Leads', {
    method: 'POST',
    body: JSON.stringify({ data: [campos], trigger }),
  });
  const fila = (res.data || [])[0] || {};
  const id = fila?.details?.id || null;
  if (!id) {
    console.log('[manychat-lead] Zoho rechazo el alta', JSON.stringify(res));
    return responder({ ok: false, accion: 'create', error: fila.message || 'Zoho no devolvio id', zoho: fila }, 502);
  }
  return responder({ ok: true, accion: 'create', id, telefono, campos });
};

export const config = { path: '/manychat-lead' };
export { extraerTelefono, extraerNombre };
