/*
 * ─── QUE EL ORIGEN NO SE PIERDA ────────────────────────────────────────────
 *
 * Ignacio (22-sep-2026): "siempre Posibles clientes → Clientes → Trato, no se
 * pierda nunca eso; que lleve todo, renovación y apertura".
 *
 * Zoho no pasa las etiquetas al convertir un lead (medido: 0 de 12 contactos y
 * 0 de 12 tratos las heredaron), y sin la etiqueta no se puede contestar de
 * dónde salió una venta: el 21-sep el módulo Tratos no sabía nada de Matías ni
 * de Lili. Los 18 campos de atribución sí viajaban bastante bien, así que esto
 * completa los que falten y sobre todo suma las etiquetas.
 *
 * Los cuatro candados, que son lo que hace que esto sea seguro:
 *
 *  1. EL ORIGEN VIAJA HACIA ADELANTE. Si el lead nació después del registro, no
 *     lo trajo: es un cliente viejo que volvió a escribir. Sin esto, el lead que
 *     abre un cliente al escribirle al +52 le pega "WhatsApp Matias" a una venta
 *     de 2025. Y se miran TODOS los leads de la persona: la etiqueta se queda si
 *     alguno anterior ya la traía.
 *  2. SOLO ETIQUETAS DE ORIGEN. Las de estado ("Posible cliente", "Formulario
 *     incompleto") no se copian: en la ficha de alguien que ya pagó son peores
 *     que el vacío.
 *  3. NADA HEREDA DE UNA GESTORÍA. El contacto del trato es el socio en 214 de
 *     1.100 (confirmado, no es un error): su origen no es el de la venta. Se
 *     saltea el trato con Partner cargado o cuyo contacto tenga más de 3 tratos.
 *     Pero la venta por socio SÍ tiene origen, y es el socio: al trato con
 *     `Partner` cargado se le pone la etiqueta `Partner: <nombre>` (Ignacio,
 *     22-sep). Al que parece gestoría por cantidad de tratos pero no tiene el
 *     campo cargado no se le inventa ninguno: queda listado para mirar a mano.
 *  4. LLENA SOLO LO VACÍO, NUNCA PISA. Y escribe con `trigger: []`, si no las
 *     11 reglas de Leads programan un WhatsApp para el día hábil siguiente.
 *
 * Es idempotente: pasa entera cada vez y solo escribe lo que falta.
 */
import { get, token } from './conversaciones/zoho.js';

const API = 'https://www.zohoapis.com/crm/v6';
// Los campos de origen que existen en los tres módulos (Etapa_Meta es fórmula).
const ORIGEN_CAMPOS = ['Lead_Source', 'Landing_Origen', 'Calendario', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'fbclid', 'Campa_a_Meta', 'Conjunto_de_anuncios', 'Anuncio', 'Preview_del_anuncio', 'Url_del_anuncio', 'leadchain0__Social_Lead_ID', 'Referido', 'Origen_original_respaldo'];
// Identidad de Meta: son los parámetros con los que `venta-meta` puede matchear
// la compra. Medido 22-sep: `fbp` está en 315 de 4.000 leads y solo en 17 de
// 1.260 contactos, así que hoy muere al convertir. No recupera casi nada hacia
// atrás (1 trato), pero de acá en adelante es lo que mejora el match.
const META_CAMPOS = ['fbc', 'fbp', 'ip', 'userAgent'];
// Lo que contestó en el formulario y lo que pidió: el vendedor lo pierde justo
// cuando le sirve. "¿Cuentas con 500 USD?" lo respondieron 1.301 leads y sobrevive
// en 25 contactos. `Tipo` dice qué vino a buscar (Apertura, Relay, Contabilidad…).
const FICHA_CAMPOS = ['Tipo', 'Asistio_al_Meeting', 'Description', 'Secondary_Email', 'Phone', 'Cuentas_con_500_USD_para_invertir', 'Tienes_tu_LLC_abierta_en_USA', 'Quer_s_abrir_una_cuenta_bancaria_americana', 'Cu_nto_Cobras_actualmente_al_mes', 'Cu_l_es_tu_actividad_principal'];
// Lo que NUNCA viaja, aunque esté: `Fecha_Siguiente_Mensaje`, `N_mero_de_mensaje`,
// `Nombre_retargeting` y `Motivo_de_perdida` son el estado de la cadencia. En la
// ficha de un cliente no significan nada y pueden hacer salir un WhatsApp.
export const CAMPOS = [...ORIGEN_CAMPOS, ...META_CAMPOS, ...FICHA_CAMPOS];
const ORIGEN = /^(Form |FORM |Lead Cal$|LLC Apertura|WhatsApp Matias$|Contactado por Mat|Agend. con Mat|Referido|From |Socio |Partner)/i;
const TRATOS_PARA_SER_GESTORIA = 3;
// Zoho rechaza toda etiqueta de más de 25 caracteres (INVALID_DATA maximum_length
// 25). "Partner: Tax Solutions LATAM" son 28: por eso fallaron justo los socios de
// nombre largo. Se corta por palabra entera, nunca a la mitad.
const MAX_ETIQUETA = 25;
export function etiquetaSocio(nombre) {
  const completa = `Socio ${String(nombre || '').trim()}`;
  if (completa.length <= MAX_ETIQUETA) return completa;
  const partes = completa.split(' ');
  let corta = partes.shift();
  for (const p of partes) { if ((`${corta} ${p}`).length > MAX_ETIQUETA) break; corta += ` ${p}`; }
  return corta;
}

// Solo para `Origen_original_respaldo`, que es un texto "Fuente=… | Landing=…" y
// a veces viene sin un solo valor. NO vale para los demás campos: casi ningún
// valor normal tiene un "=" adentro y los descartaría a todos.
const respaldoVacio = (k, v) => k === 'Origen_original_respaldo' && typeof v === 'string' && !/=\s*[^\s|]/.test(v);
const dig = (n) => String(n || '').replace(/\D/g, '');
const tags = (r) => (r.Tag || []).map((t) => t.name);

/** El mismo teléfono guardado de las dos maneras: con y sin el 9 argentino / 1 mexicano. */
export function variantesDe(numero) {
  const d = dig(numero);
  if (d.length < 8) return [];
  const b = new Set([d]);
  if (/^549\d{10}$/.test(d)) b.add('54' + d.slice(3));
  if (/^54[1-9]\d{9}$/.test(d) && !d.startsWith('549')) b.add('549' + d.slice(2));
  if (/^521\d{10}$/.test(d)) b.add('52' + d.slice(3));
  if (/^52[2-9]\d{9}$/.test(d)) b.add('521' + d.slice(2));
  return [...b];
}

/**
 * Qué campos existen de verdad en cada módulo. 12 de los que se llevan no están
 * en Tratos (`fbp`, `ip`, `Tipo`, las respuestas del formulario…) y pedir uno
 * que no existe rompe la consulta entera, así que se lee el esquema y se usa la
 * intersección. Además así no hay que tocar código si alguien agrega un campo.
 */
async function camposDe(modulo) {
  const j = await get(`settings/fields?module=${modulo}`);
  return new Set((j.fields || []).map((f) => f.api_name));
}
const soloLosQueExisten = (lista, existentes) => lista.filter((k) => existentes.has(k));

async function todos(modulo, campos, extra = '') {
  const out = [];
  let pageToken = null, page = 1;
  // Tope alto a propósito: el corte real es `more_records`. Con 40 vueltas se
  // leían 8.000 leads y quedaban fichas sin mirar.
  for (let i = 0; i < 150; i++) {
    const base = `${modulo}?fields=${campos}&sort_by=Created_Time&sort_order=desc&per_page=200${extra}`;
    const j = await get(pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : `${base}&page=${page}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
    pageToken = j.info?.next_page_token || null;
    if (!pageToken) { page++; if (page * 200 > 2000) break; }
  }
  return out;
}

async function escribir(ruta, cuerpo, metodo = 'POST') {
  const r = await fetch(`${API}/${ruta}`, {
    method: metodo,
    headers: { Authorization: `Zoho-oauthtoken ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Zoho ${metodo} ${ruta}: ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}

/**
 * Qué le falta a `registro` de lo que tiene `fuente`, mirando los leads de esa
 * persona para no traer una etiqueta de después. `nacio` es la fecha del
 * registro (para un contacto, la de su trato más viejo: Contactos no devuelve
 * Created_Time por ninguna vía, ni fields= ni search ni COQL).
 */
export function loQueFalta(registro, fuente, { leads = [], nacio = null, permitidos = null } = {}) {
  if (!fuente) return null;
  const lista = permitidos || CAMPOS;
  const campos = {};
  // El candado del tiempo vale también para los campos: una fuente posterior al
  // registro no lo trajo, así que tampoco le presta su canal ni sus utm.
  const posterior = fuente.Created_Time && nacio && new Date(fuente.Created_Time) > new Date(nacio);
  if (!posterior) for (const k of lista) if (!registro[k] && fuente[k] && !respaldoVacio(k, fuente[k])) campos[k] = fuente[k];
  const yaTiene = tags(registro);
  const antes = (t) => !nacio || leads.some((l) => new Date(l.Created_Time) <= new Date(nacio) && tags(l).includes(t));
  const etiquetas = tags(fuente).filter((t) => ORIGEN.test(t) && !yaTiene.includes(t) && antes(t));
  return (Object.keys(campos).length || etiquetas.length) ? { campos, etiquetas } : null;
}

export async function pasadaOrigen({ aplicar = true } = {}) {
  const desde = Date.now();
  const esquema = { Leads: await camposDe('Leads'), Contacts: await camposDe('Contacts'), Deals: await camposDe('Deals') };
  const campoDe = { Leads: soloLosQueExisten(CAMPOS, esquema.Leads), Contacts: soloLosQueExisten(CAMPOS, esquema.Contacts), Deals: soloLosQueExisten(CAMPOS, esquema.Deals) };
  const leads = await todos('Leads', `id,Full_Name,Mobile,Phone,Email,Tag,Created_Time,${campoDe.Leads.join(',')}`, '&converted=both');
  const porTel = new Map(), porMail = new Map();
  const sumar = (mapa, clave, l) => { if (!clave) return; if (!mapa.has(clave)) mapa.set(clave, []); mapa.get(clave).push(l); };
  for (const l of leads) {
    for (const v of [...variantesDe(l.Mobile), ...variantesDe(l.Phone)]) sumar(porTel, v, l);
    const m = (l.Email || '').trim().toLowerCase();
    if (m.includes('@')) sumar(porMail, m, l);
  }
  const leadsDe = (r) => {
    const out = new Map();
    for (const v of [...variantesDe(r?.Mobile), ...variantesDe(r?.Phone)]) for (const l of porTel.get(v) || []) out.set(l.id, l);
    for (const l of porMail.get((r?.Email || '').trim().toLowerCase()) || []) out.set(l.id, l);
    return [...out.values()];
  };

  const contactos = await todos('Contacts', `id,Full_Name,Mobile,Phone,Email,Tag,Account_Name,${campoDe.Contacts.join(',')}`);
  const tratos = await todos('Deals', `id,Deal_Name,Type,Created_Time,Contact_Name,Account_Name,Tag,Partner,${campoDe.Deals.join(',')}`);

  // "Cliente desde" = su trato más viejo, y cuántos tratos tiene cada contacto
  // (con más de 3 es una gestoría: su origen no es el de la venta).
  const clienteDesde = new Map(), cuantos = new Map();
  for (const d of tratos) {
    const id = d.Contact_Name?.id;
    if (!id) continue;
    cuantos.set(id, (cuantos.get(id) || 0) + 1);
    const previo = clienteDesde.get(id);
    if (!previo || d.Created_Time < previo) clienteDesde.set(id, d.Created_Time);
  }

  const pendientes = { Contacts: [], Deals: [] };
  const quedara = new Map(); // el contacto ya completado, para que el trato herede eso
  for (const c of contactos) {
    const suyos = leadsDe(c);
    const nacio = clienteDesde.get(c.id) || null;
    const lead = suyos.filter((l) => !nacio || new Date(l.Created_Time) <= new Date(nacio)).sort((a, b) => (a.Created_Time < b.Created_Time ? -1 : 1))[0] || null;
    const falta = loQueFalta(c, lead, { leads: suyos, nacio, permitidos: campoDe.Contacts });
    if (falta) pendientes.Contacts.push({ modulo: 'Contacts', id: c.id, quien: c.Full_Name, desde: `lead ${lead?.Full_Name}`, ...falta });
    quedara.set(c.id, { ...c, ...(falta?.campos || {}), Tag: [...tags(c), ...(falta?.etiquetas || [])].map((name) => ({ name })) });
  }
  let salteados = 0;
  const sinSocioCargado = [];
  for (const d of tratos) {
    const idc = d.Contact_Name?.id;
    if (d.Partner || (cuantos.get(idc) || 0) > TRATOS_PARA_SER_GESTORIA) {
      salteados++;
      if (d.Partner) {
        // La venta por socio no hereda el canal del contacto, pero su origen ES
        // el socio: eso sí se puede decir, porque sale de un campo del trato.
        const etiqueta = etiquetaSocio(d.Partner);
        if (!tags(d).includes(etiqueta)) pendientes.Deals.push({ modulo: 'Deals', id: d.id, quien: d.Deal_Name, desde: `socio ${d.Partner}`, campos: {}, etiquetas: [etiqueta] });
      } else {
        sinSocioCargado.push({ id: d.id, quien: d.Deal_Name, contacto: d.Contact_Name?.name, tratosDeEseContacto: cuantos.get(idc) || 0 });
      }
      continue;
    }
    const c = quedara.get(idc);
    if (!c) continue;
    const falta = loQueFalta(d, c, { leads: leadsDe(c), nacio: d.Created_Time, permitidos: campoDe.Deals });
    if (falta) pendientes.Deals.push({ modulo: 'Deals', id: d.id, quien: d.Deal_Name, desde: `contacto ${c.Full_Name}`, ...falta });
  }

  const resumen = { leidos: { leads: leads.length, contactos: contactos.length, tratos: tratos.length }, salteadosPorGestoria: salteados, gestoriaSinSocioCargado: sinSocioCargado.length, contactos: pendientes.Contacts.length, tratos: pendientes.Deals.length, campos: 0, etiquetas: 0, fallos: [], detalle: [], aplicar };
  if (!aplicar) { resumen.plan = pendientes; return resumen; }

  for (const modulo of ['Contacts', 'Deals']) {
    const lista = pendientes[modulo];
    const conCampos = lista.filter((x) => Object.keys(x.campos).length);
    for (let i = 0; i < conCampos.length; i += 100) {
      const lote = conCampos.slice(i, i + 100);
      try {
        // trigger [] = sin esto, editar un lead/contacto despierta las reglas que
        // programan un WhatsApp para el día hábil siguiente.
        const j = await escribir(modulo, { data: lote.map((x) => ({ id: x.id, ...x.campos })), trigger: [] }, 'PUT');
        (j.data || []).forEach((res, n) => { if (res.code === 'SUCCESS') resumen.campos++; else resumen.fallos.push(`${modulo} ${lote[n].quien}: ${res.code}`); });
      } catch (e) { resumen.fallos.push(`${modulo} campos: ${e.message}`); }
    }
    for (const x of lista.filter((x) => x.etiquetas.length)) {
      try {
        // add_tags quiere body JSON; por query params da INVALID_DATA.
        await escribir(`${modulo}/${x.id}/actions/add_tags`, { tags: x.etiquetas.map((name) => ({ name })) });
        resumen.etiquetas += x.etiquetas.length;
        resumen.detalle.push(`${x.quien} ← ${x.desde}: ${x.etiquetas.join(', ')}`);
      } catch (e) { resumen.fallos.push(`${modulo} ${x.quien} etiquetas: ${e.message}`); }
    }
  }
  resumen.segundos = Math.round((Date.now() - desde) / 1000);
  return resumen;
}
