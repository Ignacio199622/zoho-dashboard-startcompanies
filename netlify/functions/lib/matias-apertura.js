/*
 * LA APERTURA DE MATÍAS. Cada 15 minutos mira qué leads nuevos entraron a
 * Posibles clientes por los formularios de Meta (apertura, Lili, socios) y les
 * manda el primer mensaje desde el +52.
 *
 * ─── SINERGIA CON EL 786 (Ignacio, 13-sep) ─────────────────────────────────
 *
 * El 786 ya le mandó el mensaje 1 de la cadencia al minuto 0. Matías entra
 * como una persona del equipo que sigue ese primer contacto:
 *
 *   - espera 5 minutos desde que el lead entró, para no llegar antes que el 786;
 *   - si el lead YA está hablando por el 786 (contestó y alguien lo atiende, o
 *     un vendedor le escribió), Matías no se mete: una conversación viva alcanza;
 *   - la apertura no repite el link ni el pitch del 786: hace UNA pregunta.
 *
 * ─── POR QUÉ ES PLANTILLA ──────────────────────────────────────────────────
 *
 * Meta solo deja iniciar con plantilla aprobada. Hay una por origen
 * (`PLANTILLAS` en el cerebro). Hasta que Meta la apruebe, la apertura se
 * propone en el hilo de #sdr y no sale.
 *
 * ─── LO QUE NO HACE ────────────────────────────────────────────────────────
 *
 * No toca el lead en Zoho (ni estado, ni cadencia): solo deja la nota. Nada de
 * lo que hace acá despierta una regla.
 */
import { claveTel } from './tel-clave.js';
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { get } from './conversaciones/zoho.js';
import { conversacionesDesde } from './conversaciones/zoho.js';
import { candadoCliente, buscarCliente } from './matias-cliente.js';
import { LINEA_ACTUAL, LINEAS, WABA, mandar, plantilla as armarPlantilla, registrar, enHilo, saludDelNumero, etiquetarLead, ETIQUETA_CONTACTADO } from './matias.js';
import { origenDe, PLANTILLAS, paisDe, plantillaPara, textoDe, conBotones } from './matias-cerebro.js';
import * as hilo from './hilo.js';

const SOCIAL_ID = 'leadchain0__Social_Lead_ID';
const CAMPOS = ['id', 'Full_Name', 'First_Name', 'Mobile', 'Phone', 'Created_Time', 'Lead_Status', 'Tag', 'Tipo',
  'Nombre_retargeting', 'reserva', 'Calendario', 'Email', SOCIAL_ID].join(',');
const ESPERA_MIN = 5;
// Cuánto para atrás se mira. 24 h y no 90 min: el lead que entra a las 2 de la
// mañana recibe su apertura a las 9, y una carga a mano de la tarde que quedó
// para el día siguiente no se pierde. Lo ya tocado se saltea por el almacén.
const VENTANA_MIN = 24 * 60;
// Techo diario de aperturas. Entran 10 a 25 leads por día; si un día entran 200
// es un error de Lead Chain, no demanda, y el +52 no tiene que pagarlo.
const TOPE_DIA = Number(env.MATIAS_TOPE_DIA || 40);
// Ritmo: como mucho 6 aperturas por corrida (cada 15 min). Una carga a mano de
// 30 leads de golpe (pasó el 13-sep) sale en una hora y cuarto, no en un
// minuto. Ignacio: "tratá de que no nos bloqueen".
const MAX_POR_PASADA = Number(env.MATIAS_MAX_POR_PASADA || 6);

const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const solo9 = (t) => String(t || '').replace(/\D/g, '').slice(-9);
const digitos = (t) => String(t || '').replace(/\D/g, '');

// Horario de apertura: 9 a 21 hora Argentina. De noche no se abre nada; el
// lead que entró a las 2 recibe la apertura a las 9 (la corrida lo vuelve a ver).
function horaArgentina(ahora) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }).format(ahora));
}
export const esHoraDeAbrir = (ahora = new Date()) => { const h = horaArgentina(ahora); return h >= 9 && h < 21; };

// Un lead "de formulario" es el que trae Social Lead ID (lo cargó Lead Chain) O
// una etiqueta "Form ..." (Form Nov Meta, FORM META AGOSTO, Form Lili, Form
// Socios Meta). La segunda condición importa: el 13-sep entraron 31 leads del
// form Noviembre cargados a mano, en ráfaga, sin Social Lead ID, y Matías no
// los vio. Lead Chain dejó de empujar ese formulario el 4-sep.
const esDeFormulario = (l) => Boolean(l[SOCIAL_ID]) || (l.Tag || []).some((t) => /^form\s/i.test(t.name || t));

/** Los leads de formulario de las últimas VENTANA_MIN, del más viejo al más nuevo. */
export async function leadsNuevos(ahora = new Date()) {
  const desde = new Date(ahora - VENTANA_MIN * 60000);
  const j = await get(`Leads?fields=${CAMPOS}&sort_by=Created_Time&sort_order=desc&per_page=200`);
  return (j.data || [])
    .filter((l) => esDeFormulario(l) && new Date(l.Created_Time) >= desde)
    .reverse();
}

// ─── EL BARRIDO (Ignacio, 15-sep) ──────────────────────────────────────────
//
// "Empezá a mandar por afuera todos los de septiembre de form Noviembre, form
// Agosto, Lili y socios". Además de los nuevos de las últimas 24 h, Matías
// abre a los leads viejos del mes que nunca tocó: los del form Nov Meta y FORM
// META AGOSTO, y todos los de Lili y socios/partners. Del más nuevo al más
// viejo (el de ayer vale más que el del día 1), con el mismo ritmo de 6 por
// corrida y detrás de los nuevos del día. Se prende con el blob `backfill`
// {desde, hasta, piso, tope, abiertos}: una ventana de un mes por vez. Cuando
// no queda nadie en la ventana, retrocede un mes (Ignacio, 15-sep: "y antes
// también, los que tengamos en Posibles clientes") hasta `piso`, y ahí se
// apaga. Septiembre va por formularios (Nov/Agosto/Lili/socios); de agosto
// para atrás van TODOS los leads de Posibles clientes. Un lead viejo ya
// recibió la cadencia entera del 786, así que se mira si alguien lo atendió
// (no solo 24 h) y se saltea al que está perdido o ya dijo que no.
// ─── EL BARRIDO SANO (Ignacio, 18-sep: "un barrido más sano") ──────────────
// El barrido del 15-17 sep (391 aperturas en 3 días a leads de meses, 23% de
// rebotes 131049) puso YELLOW al +52. Ahora: cupo propio por día (`porDia`,
// 25), solo leads de formulario (nunca `todos`), piso julio (los de más de dos
// meses no se tocan) y SOLO con plantillas con botones (el que no quiere tiene
// un "No me interesa" que no es reportarnos). Sin plantilla `_btn` aprobada en
// la línea, el viejo espera; el nuevo del día sale igual con la que haya.
const CLAVE_BACKFILL = 'backfill';
const PISO_BACKFILL = '2026-07-01T00:00:00-03:00';
const POR_DIA_BACKFILL = 25;
const mesAntes = (iso) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10) + 'T00:00:00-03:00'; };
/** "sep-2026" para el hilo y el reporte. */
export const etiquetaMes = (iso) => new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: 'short', year: 'numeric' }).replace('.', '').replace(' ', '-');
const FORMS_BACKFILL = /^form\s+(nov|meta\s+agosto)/i;
const PERDIDO = /perdid|no\s*interes|descart|no\s*califica|baja|cliente|cerrad|junk|spam/i;
// Leads de prueba del equipo (QA del portal y de los forms): "asdasd", "qa-fields",
// "qa.persist.1785…", "administracioasdn1", "ignacio", "test". Rebotan 131026 pero
// gastan el tope del día y ensucian el canal (11 de 119 el 16-sep).
const PRUEBA = /^(asd|qa[\s.\-_]|qa$|test|prueba)|asd|qwe|zxc|\d{6,}/i;
export const esLeadDePrueba = (lead) => {
  const nombre = String(lead.Full_Name || '').trim();
  const mail = String(lead.Email || '');
  // Un nombre de una letra (".", "K", "M") NO es prueba: hoy contestaron y eran gente real.
  return PRUEBA.test(nombre) || /(asd|test|prueba|qa\.)/i.test(mail) || /^\+?1?(1234|0000|1111|5555)/.test(String(lead.Mobile || lead.Phone || '').replace(/[\s-]/g, ''));
};
// El barrido y la apertura siguen tratando como 'ctwa' al que escribió desde un anuncio, aunque
// origenDe ahora ponga Lili/partners primero (eso es para elegir calendario, 16-oct).
const origenApertura = (l) => ((l.Tag || []).some((t) => /whatsapp matias/i.test(String(t.name || t))) ? 'ctwa' : origenDe(l));
const esDelBarrido = (l) => {
  const tags = (l.Tag || []).map((t) => String(t.name || t));
  if (tags.some((t) => FORMS_BACKFILL.test(t))) return true;
  return ['lili', 'socios', 'partner'].includes(origenApertura(l));
};

/**
 * Los leads del barrido creados en [desde, hasta), del más nuevo al más viejo.
 * Con `todos`, cualquier lead de Posibles clientes; si no, solo los de formulario.
 */
export async function leadsDelBarrido(desde, hasta = null, todos = false) {
  const criterio = encodeURIComponent(hasta ? `((Created_Time:greater_equal:${desde})and(Created_Time:less_than:${hasta}))` : `(Created_Time:greater_equal:${desde})`);
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get(`Leads/search?criteria=${criterio}&fields=${CAMPOS}&sort_by=Created_Time&sort_order=desc&per_page=200&page=${page}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  return todos ? out : out.filter(esDelBarrido);
}

export async function estadoBarrido() {
  return almacen().get(CLAVE_BACKFILL, { type: 'json' }).catch(() => null);
}
export async function prenderBarrido({ desde, hasta = null, piso = PISO_BACKFILL, tope = 150, todos = false, porDia = POR_DIA_BACKFILL, ahora = new Date() }) {
  const b = { desde, hasta, piso: piso || PISO_BACKFILL, tope, todos, porDia, abiertos: 0, activadoEl: ahora.toISOString() };
  await almacen().setJSON(CLAVE_BACKFILL, b);
  return b;
}
/** La ventana anterior (un mes para atrás). null si ya se llegó al piso. */
export function ventanaAnterior(b) {
  const desde = mesAntes(b.desde);
  if (desde < (b.piso || PISO_BACKFILL)) return null;
  // Se conserva el criterio con el que se prendió (el barrido sano nunca pasa a `todos`).
  return { ...b, desde, hasta: b.desde, todos: Boolean(b.todos), ventanaDesde: new Date().toISOString() };
}
export async function apagarBarrido() { await almacen().delete(CLAVE_BACKFILL).catch(() => {}); }

/** Estado de las plantillas de Matías en Meta: { nombre: 'APPROVED' | 'PENDING' | ... }. Por WABA (cada línea tiene la suya). */
export async function estadoPlantillas(waba = WABA) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${waba}/message_templates?fields=name,status&limit=100&access_token=${env.META_WHATSAPP_TOKEN}`);
  const j = await r.json();
  const out = {};
  for (const t of j.data || []) out[t.name] = t.status;
  return out;
}

/** ¿El lead ya está conversando por el 786? Entonces Matías no se mete. */
// Las plantillas de la cadencia del 786 salen firmadas por "Start Companies
// Staff" (medido el 15-sep: 1.454 de 2.000 conversaciones del mes, 98 de 99 con
// estos textos). Eso no es un vendedor atendiendo: es el bot. Solo cuenta como
// atendido si el lead escribió, si contestó una persona con nombre, o si el
// Staff escribió algo que no es plantilla.
export function conviveCon786(conversaciones, numero) {
  const c = conversaciones.find((x) => solo9(x.mobile_number__s) === solo9(numero));
  if (!c) return null;
  if (c.conversation_status__s === 'Responded') return 'el lead escribió al 786 y lo están atendiendo';
  const quien = c.replied_by__s?.name || '';
  if (!quien) return null;
  // "Start Companies Staff" es el bot de Zoho: cadencia, confirmación de 24 h,
  // recordatorio, aviso de no-show. Los humanos firman con su nombre (Santiago,
  // Camila, Guadalupe, Ignacio Campo). El 16-sep, 20 de 21 no-shows de Matías se
  // saltearon porque el aviso automático del 786 contaba como "vendedor".
  if (/start companies staff/i.test(quien)) return null;
  return `un vendedor ya le contestó por el 786 (${quien})`;
}

// La apertura es el primer mensaje: sale por la línea ACTUAL, y la ficha se queda con ella.
const enviarPlantilla = (numero, nombre, primerNombre) => mandar(numero, armarPlantilla(nombre, [primerNombre]), { linea: LINEA_ACTUAL });

// Texto de cada apertura, para el hilo de Slack y la nota (la plantilla real la
// arma Meta, esto es lo que dice).
// Los textos viven en el cerebro (TEXTOS), en vos y en tú.

/**
 * Una pasada. Devuelve el resumen para el log. `enviar` decide si sale de
 * verdad (MATIAS_ENVIAR=1) o si solo se propone en #sdr.
 */
export async function pasada({ ahora = new Date(), enviar = false } = {}) {
  const resumen = { vistos: 0, abiertos: 0, propuestos: 0, salteados: [] };
  if (!esHoraDeAbrir(ahora)) { resumen.motivo = 'fuera de horario'; return resumen; }
  // El fusible (ver matias.js): si la línea actual no está GREEN, se propone y no se manda.
  const salud = await saludDelNumero(ahora, LINEA_ACTUAL);
  if (enviar && !salud.ok) { enviar = false; resumen.motivo = `fusible: ${salud.motivo}`; }

  const leads = await leadsNuevos(ahora);
  resumen.vistos = leads.length;
  const barrido = enviar ? await estadoBarrido() : null;
  if (!leads.length && !barrido) return resumen;

  const store = almacen();
  // Candado: dos pasadas a la vez (el cron y un disparo a mano, o dos crons
  // pisados) se reparten los mismos leads y uno recibe dos aperturas. Pasó el
  // 13-sep a las 20:37: 12 leads que ya estaban marcados salieron igual.
  const candado = await store.get('lock-apertura').catch(() => null);
  if (candado && ahora - new Date(candado) < 10 * 60000) { resumen.motivo = 'otra pasada en curso'; return resumen; }
  await store.set('lock-apertura', ahora.toISOString());
  const claveDia = `dia-${ahora.toISOString().slice(0, 10)}`;
  let abiertosHoy = Number((await store.get(claveDia)) || 0);
  // El cupo diario del barrido, aparte del total del día.
  const claveDiaBarrido = `barrido-dia-${ahora.toISOString().slice(0, 10)}`;
  let viejosHoy = Number((await store.get(claveDiaBarrido)) || 0);
  const plantillas = await estadoPlantillas();
  // Con barrido, las conversaciones del 786 se miran desde el arranque del
  // período: un lead del día 3 puede haber sido atendido el día 5.
  const conversaciones = await conversacionesDesde(barrido ? new Date(barrido.desde) : new Date(ahora - 24 * 3600000));

  // Los del barrido van detrás de los nuevos del día y solo si queda ritmo.
  const delBarrido = new Set();
  if (barrido) {
    if (barrido.abiertos >= barrido.tope) { await apagarBarrido(); resumen.motivo = `barrido terminado por tope (${barrido.tope})`; }
    else {
      const viejos = (await leadsDelBarrido(barrido.desde, barrido.hasta, barrido.todos)).filter((l) => !leads.some((n) => n.id === l.id));
      resumen.barrido = { ventana: etiquetaMes(barrido.desde), candidatos: viejos.length, abiertos: 0 };
      for (const l of viejos) { leads.push(l); delBarrido.add(l.id); }
    }
  }
  // Meta corta a 250 conversaciones iniciadas por día en un número nuevo: el
  // barrido no puede llevar el total del día más allá de 230.
  const TOPE_META = 230;
  let pendientesBarrido = 0;

  for (const lead of leads) {
    const esViejo = delBarrido.has(lead.id);
    const tel = lead.Mobile || lead.Phone;
    const clave = `apertura-${claveTel(tel) || lead.id}`;
    const saltear = (motivo) => { resumen.salteados.push(`${lead.Full_Name}: ${motivo}`); };

    // Ya tocado. Una marca "propuesta …" (quedó así porque el fusible o MATIAS_ENVIAR
    // estaban apagados) NO cuenta cuando ahora sí se puede mandar: el 18-sep los 9 leads
    // del día quedaron mudos para siempre por esa marca (el +52 pasó YELLOW y volvió).
    const marca = await store.get(clave);
    if (marca && !(enviar && /^propuesta/.test(String(marca)))) continue;
    if (!tel) { saltear('sin teléfono'); await store.set(clave, 'sin telefono'); continue; }
    if (!String(tel).trim().startsWith('+') || !paisDe(tel)) { saltear('teléfono sin código de país'); await store.set(clave, 'sin prefijo'); continue; }
    if (esLeadDePrueba(lead)) { saltear('lead de prueba'); await store.set(clave, 'prueba'); continue; }
    // Meta no entrega plantillas de marketing a números de Estados Unidos (+1) desde
    // abril de 2025: rebotan 131049 y ensucian la calidad. A esos los sigue el 786.
    if (paisDe(tel) === 'US') { saltear('número de EE.UU.: Meta no entrega marketing'); await store.set(clave, 'eeuu'); continue; }
    if ((ahora - new Date(lead.Created_Time)) / 60000 < ESPERA_MIN) { saltear('entró hace menos de 5 min, esperamos al 786'); continue; }

    // Si ya reservó (por Cal o a mano), Matías no abre: el que agendó no recibe más pitch.
    if (lead.reserva === true || lead.Calendario || /agendad/i.test(String(lead.Lead_Status || ''))) { saltear('ya agendó'); await store.set(clave, 'agendo'); continue; }
    if (esViejo && PERDIDO.test(String(lead.Lead_Status || ''))) { saltear(`estado ${lead.Lead_Status}`); await store.set(clave, `estado: ${lead.Lead_Status}`); continue; }

    const motivo786 = conviveCon786(conversaciones, tel);
    if (motivo786) { saltear(motivo786); await store.set(clave, `786: ${motivo786}`); continue; }

    // El candado de cliente: teléfono (con variantes), mail y nombre contra
    // Contactos, Propietarios de LLC y LLCs. Samah (jun-2026) tenía otro número
    // en su ficha de cliente y solo el nombre la delataba.
    const cliente = await candadoCliente(tel, { nombre: lead.Full_Name, email: lead.Email, ahora });
    if (cliente.es) { saltear(`ya es cliente: ${cliente.quien} (${cliente.como})`); await store.set(clave, `cliente: ${cliente.quien}`); continue; }

    const origen = origenApertura(lead);
    const plantilla = plantillaPara(origen, tel, plantillas);
    // Brasil (pt) sin gemela _pt aprobada: no se abre (nunca en español). Sin marca: se reintenta.
    if (!plantilla) { saltear('portugués: sin plantilla _pt aprobada'); continue; }
    const nombre = lead.First_Name || String(lead.Full_Name || '').split(' ')[0] || 'qué tal';
    const texto = textoDe(origen, plantilla, nombre);

    // El tope y el ritmo se miran ANTES de registrar: si no, cada pasada que
    // dejaba el lead "para la próxima" posteaba la apertura en el hilo y dejaba
    // una nota en Zoho sin mandar nada (el 14-sep: 5 veces al mismo lead).
    if (enviar && plantillas[plantilla] === 'APPROVED') {
      if (esViejo) {
        // El tope del barrido es propio (no el de 40 del día), pero el techo de Meta es uno solo.
        if (barrido.abiertos >= barrido.tope || abiertosHoy >= TOPE_META) { pendientesBarrido++; continue; }
        // Barrido sano: cupo propio por día, y solo con la plantilla con botones.
        if (viejosHoy >= (barrido.porDia || POR_DIA_BACKFILL)) { pendientesBarrido++; continue; }
        if (!conBotones(plantilla)) { pendientesBarrido++; continue; }
      } else if (abiertosHoy >= TOPE_DIA) { saltear(`tope del día (${TOPE_DIA}) alcanzado`); continue; }
      if (resumen.abiertos >= MAX_POR_PASADA) { if (esViejo) pendientesBarrido++; else saltear('ritmo: queda para la próxima corrida'); continue; }
    }
    // Registrar abre el hilo de #sdr y deja la nota. Se hace antes de mandar
    // para que, si Meta falla, quede el rastro de que se intentó.
    const r = await registrar({ numero: digitos(tel), de: 'matias', texto: `${enviar && plantillas[plantilla] === 'APPROVED' ? '' : '[APERTURA PROPUESTA, no enviada] '}${texto}`, cuando: ahora, apertura: { tipo: esViejo ? 'viejo' : 'nuevo', origen, creado: lead.Created_Time } });

    if (!enviar || plantillas[plantilla] !== 'APPROVED') {
      const porQue = !enviar ? (salud.ok ? 'MATIAS_ENVIAR apagado' : `fusible, ${salud.motivo}`) : `plantilla ${plantilla} en estado ${plantillas[plantilla] || 'inexistente'}`;
      await enHilo(digitos(tel), `💡 Apertura *${origen}* propuesta (no se mandó: ${porQue}).`);
      await store.set(clave, `propuesta ${ahora.toISOString()}`);
      resumen.propuestos++;
      continue;
    }

    // Se reserva ANTES de mandar: si otra pasada llega un segundo después, ve
    // la marca y no manda de nuevo. Si Meta falla, se libera.
    await store.set(clave, `en curso ${ahora.toISOString()}`);
    try {
      await enviarPlantilla(tel, plantilla, nombre);
      abiertosHoy++;
      await store.set(claveDia, String(abiertosHoy));
      await hilo.agregar(digitos(tel), 'nosotros', texto, ahora);
      await store.setJSON(clave, { enviada: ahora.toISOString(), origen, plantilla, lead: lead.id, toques: 1, linea: LINEA_ACTUAL, ...(esViejo ? { barrido: etiquetaMes(lead.Created_Time) } : {}) });
      resumen.abiertos++;
      // La marca de "Matías lo empujó" en Zoho: etiqueta, sin tocar fuente ni landing.
      const et = await etiquetarLead(lead.id, ETIQUETA_CONTACTADO, lead.Tag);
      if (et !== 'SUCCESS' && et !== 'ya estaba') console.log(`etiqueta ${ETIQUETA_CONTACTADO} en ${lead.id}: ${et}`);
      // Nuevo o viejo ya lo dice la cabecera del hilo (registrar, `apertura`).
      if (esViejo) { barrido.abiertos++; resumen.barrido.abiertos++; viejosHoy++; await store.set(claveDiaBarrido, String(viejosHoy)); await store.setJSON(CLAVE_BACKFILL, barrido); }
    } catch (e) {
      await store.delete(clave).catch(() => {});
      await enHilo(digitos(tel), `⚠️ La apertura no salió: ${e.message}`);
      saltear(`Meta: ${e.message}`);
    }
    if (r.slack !== 'ok') console.log(`slack: ${r.slack}`);
  }
  if (barrido && resumen.barrido) {
    resumen.barrido.pendientes = pendientesBarrido;
    // Sin pendientes ni abiertos en esta pasada, no queda nadie en la ventana:
    // se pasa al mes anterior, y al llegar al piso se apaga solo.
    if (!pendientesBarrido && !resumen.barrido.abiertos) {
      const anterior = ventanaAnterior(barrido);
      if (anterior) { await store.setJSON(CLAVE_BACKFILL, anterior); resumen.motivo = `barrido: ${etiquetaMes(barrido.desde)} terminado, sigue con ${etiquetaMes(anterior.desde)}`; }
      else { await apagarBarrido(); resumen.motivo = `barrido terminado (${barrido.abiertos} aperturas, hasta ${etiquetaMes(barrido.piso)})`; }
    }
  }
  await store.delete('lock-apertura').catch(() => {});
  return resumen;
}

/**
 * La previa del barrido: quiénes recibirían la apertura y quiénes no y por
 * qué. No manda, no registra, no toca el almacén. Sirve para mostrarle a
 * Ignacio la cuenta antes de prender.
 */
export async function previaBarrido(desde, hasta = null, todos = false) {
  const store = almacen();
  const viejos = await leadsDelBarrido(desde, hasta, todos);
  const conversaciones = await conversacionesDesde(new Date(desde));
  const out = { desde, vistos: viejos.length, abrir: [], saltear: [] };
  for (const lead of viejos) {
    const tel = lead.Mobile || lead.Phone;
    const clave = `apertura-${claveTel(tel) || lead.id}`;
    const ficha = { nombre: lead.Full_Name, tel, origen: origenApertura(lead), creado: lead.Created_Time, estado: lead.Lead_Status, tags: (lead.Tag || []).map((t) => t.name || t) };
    const no = (motivo) => out.saltear.push({ ...ficha, motivo });
    const marca = await store.get(clave);
    if (marca && !/^propuesta/.test(String(marca))) { no('ya tocado por Matías'); continue; }
    if (!tel) { no('sin teléfono'); continue; }
    if (!String(tel).trim().startsWith('+') || !paisDe(tel)) { no('sin código de país'); continue; }
    if (esLeadDePrueba(lead)) { no('lead de prueba'); continue; }
    if (lead.reserva === true || lead.Calendario || /agendad/i.test(String(lead.Lead_Status || ''))) { no('ya agendó'); continue; }
    if (PERDIDO.test(String(lead.Lead_Status || ''))) { no(`estado ${lead.Lead_Status}`); continue; }
    const motivo786 = conviveCon786(conversaciones, tel);
    if (motivo786) { no(motivo786); continue; }
    const cliente = await buscarCliente({ numero: tel, nombre: lead.Full_Name, email: lead.Email });
    if (cliente.es) { no(`ya es cliente: ${cliente.quien} (${cliente.como})`); continue; }
    out.abrir.push(ficha);
  }
  return out;
}
