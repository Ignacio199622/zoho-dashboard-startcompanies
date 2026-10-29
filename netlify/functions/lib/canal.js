// De qué canal vino un lead, resuelto con lo que YA está en su ficha de Zoho.
//
// POR QUE EXISTE (medido el 2026-09-04 sobre 2.000 leads desde febrero):
// El canal venia lleno al 90-95% durante todo julio y se cayo al 4% en agosto.
// No fue que dejo de llegar el dato: el slug de la landing sigue llegando. Lo
// que dejo de correr es lo que TRADUCIA ese slug a un canal.
//
// LOS CAMPOS, DESDE LA NORMALIZACION DEL 18-sep-2026 (cada uno guarda lo que
// dice su nombre; antes estaban cruzados):
//   `Lead_Source`     = "Fuente": el CANAL ("Meta Ads"). Es lo que esta funcion decide.
//   `Landing_Origen`  = "Landing de Origen": la PAGINA o el formulario por donde
//                       entro ("asesoria-llc", "Form Nov Meta"). El dato crudo.
//   `Calendario`      = el calendario de Cal donde reservo ("30min", "socios").
//                       Solo esta lleno si agendo.
//   `Canal_de_contacto` = por donde se comunico (WhatsApp, Landing, Formulario Meta...).
import { LANDING_A_CANAL } from './mapeos.js';

// Paginas del sitio, no landings de campaña. Quien llega ahi sin fbclid ni utm
// vino por su cuenta.
const PAGINAS_DEL_SITIO = new Set(['/', 'home', 'precios', 'en']);

// Estas NO se resuelven por el slug, a proposito: son paginas de agendamiento
// genericas a las que se llega desde un mail, un WhatsApp, la bio o un anuncio.
// Si tienen fbclid se resuelven por ahi; si no, quedan vacias. Un canal
// inventado es peor que uno vacio, porque nadie lo vuelve a revisar.
//
// `agendamientoform` ESTABA ACA Y NO CORRESPONDIA (sacado el 2026-09-10). Entro
// por parecerse de nombre a `agendar`, sin medirlo. Los numeros son opuestos:
//   agendar          54 leads · 7 con Social Lead ID · 26% de Meta · 40 quedan
//                    "A clasificar"  -> generica de verdad, se queda
//   agendamientoform  9 leads · 8 con Social Lead ID · 89% de Meta
//                    -> es el calendario del formulario de Meta
// `sdr-matias` es el link que manda Matias: dice quien lo escribio, no de donde vino.
const AGENDAMIENTO_GENERICO = new Set(['agendar', 'sdr-matias']);

// Satelites SEO (proyecto de Pablo): cada uno es un dominio propio.
const SATELITES = new Set(['llcargentina', 'abritullc', 'proveedoresllc', 'mejoresllc', 'rolon']);

// Calendarios de Cal que por si solos dicen de donde vino la persona. Es la
// señal mas blanda de todas: solo se usa si no hay utm, fbclid, Social Lead ID
// ni landing. `30min` y `agenda-organica` NO estan a proposito: ahi reserva
// cualquiera.
const CALENDARIO_A_CANAL = {
  agendaformmeta: 'Meta Ads',
  referidos: 'Referido',
  'agenda-ignacio': 'Marca Personal',
  'agenda-consulta-clientes': 'Cliente actual',
  'reddit-llc': 'Reddit Ads',
  'youtube-llc': 'YouTube Orgánico',
  calendarioyoutube: 'YouTube Orgánico',
  'consulta-mailcamp': 'Email Marketing',
};

// Valores que escriben integraciones que no se pueden configurar (WhatsApp de
// Zoho, SalesIQ, ManyChat). No son un canal: son "todavia no se resolvio".
// 28-sep-2026 (Ignacio): Web Organic y Landing Page tampoco son un canal, y Referidos es el Referido del alta web.
export const FUENTES_TRANSITORIAS = /^WHATSAPP|^WhatsApp - |wwebjs|^Chatbot|^Instagram Bot|^Facebook Bot|^TimelinesAI|^Web Organic$|^Landing Page$|^Referidos$|^No lo sé|^Sin origen/i;
// "No lo sé" tambien se revisa: si despues aparece una prueba (anuncio, utm, referido), se corrige sola.

const limpiar = (s) => String(s || '').toLowerCase().trim().replace(/^\//, '') || (String(s || '').trim() === '/' ? '/' : '');

// Campos de atribucion que pueden venir escondidos en una URL.
const CAMPOS_URL = ['fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];

/**
 * Las marcas del anuncio que quedaron ESCONDIDAS en una URL de la ficha.
 *
 * POR QUE (caso Vanessa Marmolejo, 19-sep-2026): clic en un anuncio de IG,
 * aterriza en asesoria-llc con fbclid y utm, la agarra el chatbot de SalesIQ
 * por intencion de salida y el bot crea el lead con `fbclid` y `utm_*` vacios.
 * La URL completa queda igual en dos lados: en `First_Visited_URL` (lo escribe
 * SalesIQ al sincronizar) y en la linea `Pagina: ...` de Description (la
 * escribe el bot). Sin esto, la regla veia "chatbot sin señal" y la marcaba
 * como organica, con el anuncio a la vista.
 *
 * Devuelve SOLO los campos que en la ficha estan vacios: nunca pisa un dato
 * que ya llego por el camino normal.
 *
 * @param {object} lead ficha de Zoho
 * @returns {object} {fbclid, utm_source, ...} solo con lo que falta y se encontro
 */
export function marcasDeUrl(lead) {
  const out = {};
  if (!lead) return out;
  const textos = [lead.First_Visited_URL, lead.Description];
  for (const t of textos) {
    // El bot escribe la Description con "\n" literal entre lineas: la barra
    // corta la URL igual que un espacio.
    const urls = String(t || '').match(/https?:\/\/[^\s"'<>\\]+/g) || [];
    for (const u of urls) {
      let q;
      try { q = new URL(u).searchParams; } catch { continue; }
      for (const k of CAMPOS_URL) {
        const v = q.get(k);
        if (v && !lead[k] && !out[k]) out[k] = v;
      }
    }
  }
  // 29-sep-2026 (Ignacio): la PAGINA donde escribio (chatbot) va a Landing de Origen si esta vacia.
  if (!lead.Landing_Origen) { const lp = landingDeUrl(lead); if (lp) out.Landing_Origen = lp; }
  return out;
}

// Subdominios que son una landing entera.
const HOST_A_LANDING = { 'socios.startcompanies.io': 'partners-sc', 'lili.startcompanies.io': 'lili-plataforma', 'liliplataforma-sc.startcompanies.io': 'lili-plataforma' };
// Solo valores que existen en el picklist de Landing de Origen: un slug suelto ensucia los reportes.
const LANDINGS_CONOCIDAS = new Set(['asesoria-llc', 'llc-7-dias', 'abre-tu-llc', 'abre-tu-llc-ads', 'agendamientoform', 'crear-llc-usa', 'abrir-llc-estados-unidos', 'agenda-organica', 'agendar', 'precios', 'home', 'en', 'partners-sc', 'lili-plataforma', 'lili-bank', 'facturacion-gratis', 'referidos', 'llcargentina']);

/** La landing de la primera URL de la ficha (First_Visited_URL o la linea "Pagina:" del chatbot). */
export function landingDeUrl(lead) {
  for (const t of [lead?.First_Visited_URL, lead?.Description]) {
    const urls = String(t || '').match(/https?:\/\/[^\s"'<>\\]+/g) || [];
    for (const u of urls) {
      let url; try { url = new URL(u); } catch { continue; }
      const host = url.hostname.toLowerCase();
      if (HOST_A_LANDING[host]) return HOST_A_LANDING[host];
      if (!/startcompanies\.(net|io)$/.test(host)) continue;
      const seg = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || 'home';
      if (LANDINGS_CONOCIDAS.has(seg)) return seg;
    }
  }
  return null;
}

/**
 * Las señales van de mas dura a mas blanda. `utm_source` lo puso la campaña,
 * `fbclid` lo agrega Meta al hacer clic en un anuncio, el Social Lead ID lo
 * deja el formulario de Meta, y la pagina es lo mas debil porque a la misma
 * pagina se llega de cualquier lado.
 *
 * @param {object} lead ficha de Zoho
 * @returns {{canal: string|null, via: string}}
 */
export function canalDelLead(ficha) {
  if (!ficha) return { canal: null, via: 'sin ficha' };
  // Lo que la integracion no cargo en los campos pero dejo en la URL cuenta
  // igual: es la misma marca, en otro lugar de la ficha.
  const deUrl = marcasDeUrl(ficha);
  const lead = { ...ficha, ...deUrl };
  const r = canalDeFicha(lead);
  const usadas = Object.keys(deUrl).filter((k) => r.via.includes(k));
  if (r.canal && usadas.length) r.via += ' (leido de la URL de la primera visita, la integracion no lo cargo en el campo)';
  return r;
}

function canalDeFicha(lead) {
  const src = String(lead.utm_source || '').toLowerCase();
  const med = String(lead.utm_medium || '').toLowerCase();
  // `utm_medium` decide si la red trajo el lead gratis o pagando. Sin mirarlo, un
  // reel de Instagram y un anuncio de Instagram son el mismo canal, y el CAC de
  // contenido queda sumado al de Meta. Paid es la excepcion explicita, no el
  // default: si el medium no dice nada, se sigue tratando como pago.
  const organico = /organic|organico|orgánico|social|bio|perfil|profile|manychat/.test(med);
  if (src) {
    const via = `utm_source=${lead.utm_source}${med ? ` utm_medium=${lead.utm_medium}` : ''}`;
    if (/youtube|yt/.test(src))            return { canal: organico ? 'YouTube Orgánico' : 'YouTube Ads', via };
    if (/reddit/.test(src))                return { canal: 'Reddit Ads', via };
    // Lo organico de Instagram es la cuenta de Ignacio (@ignacio.llc): Marca Personal.
    if (/^ig$|instagram/.test(src))        return { canal: organico ? 'Marca Personal' : 'Meta Ads', via };
    // 29-sep-2026: fb/facebook con medium organico es un posteo, no un anuncio (antes quedaba Meta Ads).
    if (/fb|facebook|meta|an$/.test(src))  return { canal: organico ? 'Marca Personal' : 'Meta Ads', via };
    if (/google|gads|adwords/.test(src))   return { canal: organico ? 'SEO / Web Orgánica' : 'Google Ads', via };
  }

  // fbclid o creativeId son prueba de que hubo un clic en un anuncio de Meta,
  // aunque despues haya aterrizado en cualquier pagina.
  if (lead.fbclid) return { canal: 'Meta Ads', via: 'fbclid' };
  if (lead.creativeId) return { canal: 'Meta Ads', via: 'creativeId' };

  // EL SOCIAL LEAD ID VA ANTES QUE LA PAGINA, Y ESTO NO ES UN DETALLE.
  // Quien llena un formulario DENTRO de Meta nunca abre un navegador, asi que
  // no trae fbclid ni utm. Despues agenda por `agenda-organica` y el slug lo
  // hace parecer trafico organico. Es de Meta.
  if (lead.leadchain0__Social_Lead_ID) return { canal: 'Meta Ads', via: 'Social Lead ID (formulario de Meta)' };

  if (lead.Referido) return { canal: 'Referido', via: 'campo Referido' };

  // La pagina por donde entro. Un nombre de formulario de Meta ("Form Nov Meta")
  // tambien es de Meta, aunque el Social Lead ID no haya llegado.
  const slug = limpiar(lead.Landing_Origen);
  if (slug) {
    if (/^form /.test(slug)) return { canal: 'Meta Ads', via: `formulario ${lead.Landing_Origen}` };
    if (!AGENDAMIENTO_GENERICO.has(slug)) {
      // 29-sep-2026 (Ignacio): entrar por una pagina del sitio sin utm ni anuncio NO prueba SEO: no sabemos.
      if (PAGINAS_DEL_SITIO.has(slug)) return { canal: null, via: `pagina del sitio ${slug} sin otra señal: no dice el canal` };
      if (SATELITES.has(slug)) return { canal: 'SEO Satélite', via: `satelite ${slug}` };
      const canal = LANDING_A_CANAL[slug];
      if (canal) return { canal, via: `landing ${slug}` };
    }
  }

  // El calendario dice COMO agendo, no DE DONDE VINO: por eso pierde contra
  // cualquier marca de origen y solo entra al final, y solo para los
  // calendarios que son de un canal en particular.
  const cal = limpiar(lead.Calendario);
  if (cal && CALENDARIO_A_CANAL[cal]) return { canal: CALENDARIO_A_CANAL[cal], via: `calendario ${cal}` };

  if (slug) return { canal: null, via: AGENDAMIENTO_GENERICO.has(slug) ? `"${slug}" es una pagina de agendamiento generica: no dice el canal` : `pagina "${slug}" sin canal asignado en el mapeo` };
  return { canal: null, via: 'la ficha no tiene ninguna señal de origen' };
}

/**
 * Que Fuente ponerle a un lead que sigue con un valor transitorio y sin ninguna
 * señal. Es honesto: dice por donde escribio y que no sabemos de donde vino.
 */
export function fuenteSinSenal(lead) {
  const ls = String(lead.Lead_Source || '');
  if (/^WHATSAPP|^WhatsApp - |wwebjs|^TimelinesAI/i.test(ls)) return 'Sin origen de fuente';
  if (!ls && (lead.Canal_de_contacto || []).includes('WhatsApp')) return 'Sin origen de fuente'; // p.ej. el que le escribe a Matías sin anuncio
  // 28-sep-2026 (Ignacio): el chatbot, "Web Organic" y "Landing Page" sin utm/anuncio/referido NO son SEO:
  // no sabemos de donde vino. Antes el chatbot quedaba como "SEO / Web Orgánica" y eso era inventar.
  if (/^Chatbot|^Web Organic$|^Landing Page$/i.test(ls)) return 'Sin origen de fuente';
  if (/^Referidos$/i.test(ls)) return 'Referido';
  if (/^Instagram Bot|^Facebook Bot/i.test(ls)) return 'Marca Personal';
  return null;
}

/** Que agregar a Canal_de_contacto segun por donde escribio. No reemplaza: suma. */
export function canalesDeContacto(lead) {
  const ls = String(lead.Lead_Source || '');
  const out = new Set(lead.Canal_de_contacto || []);
  if (/^WHATSAPP|^WhatsApp|wwebjs|^TimelinesAI/i.test(ls)) out.add('WhatsApp');
  if (/^Chatbot/i.test(ls)) out.add('Chat web');
  if (lead.leadchain0__Social_Lead_ID || /^form /i.test(String(lead.Landing_Origen || ''))) out.add('Formulario Meta');
  else if (lead.Landing_Origen) out.add('Landing');
  if (lead.Referido) out.add('Referido');
  return [...out].sort();
}

/** Los campos que hay que pedirle a Zoho para poder decidir. */
export const CAMPOS = 'id,Full_Name,Created_Time,Lead_Source,Calendario,Landing_Origen,Canal_de_contacto,Referido,fbclid,creativeId,utm_source,utm_medium,utm_campaign,utm_content,utm_term,utm_id,leadchain0__Social_Lead_ID,First_Visited_URL,Description';
