/*
 * ─── EL CANDADO DE SOCIO Y LAS FUENTES DE LA APERTURA (Ignacio, 2-nov-2026) ─
 *
 * Funciones puras, sin Zoho ni Blobs, para poder probarlas solas
 * (scripts/test-daniel-candados.mjs).
 *
 * 1. CANDADO DE SOCIO. Regla de oro: a un cliente de un socio no le llega nada
 *    con nuestra marca (Angel, Tax Solutions, 19-oct). El candado de cliente
 *    (matias-cliente.js) frena a quien ya es Contacto, Propietario o LLC; esto
 *    agrega lo que dice la ficha misma: `Bloqueo_de_envio` tildado, `Socio`
 *    cargado, `Partner` cargado (que no sea "Start Companies"/"Partner"), Tipo de
 *    partner, fuente Partner o etiqueta "Socio X" / "Partner: X". El "Posible
 *    Partner" (el que quiere SER socio, Form Socios Meta) NO es cliente de un
 *    socio: Daniel lo sigue abriendo como hasta hoy.
 *
 * 2. FUENTES EXTRA. Hasta hoy Daniel solo abre leads de formularios de Meta.
 *    Con `MATIAS_FUENTES_EXTRA_ENABLED=1` abre también los de la web/SEO,
 *    landings, YouTube, WhatsApp sin origen, marca personal, referidos y el
 *    chatbot. Cuáles: `MATIAS_FUENTES_EXTRA` (lista con comas). Apagado por
 *    defecto: nada cambia hasta que Ignacio lo prende en Netlify.
 */
import { env } from './entorno.js';

const texto = (v) => String((v && typeof v === 'object' ? v.name : v) || '').trim();
const etiquetas = (r) => (r?.Tag || []).map((t) => texto(t));
const SOCIO_PROPIO = /^(start companies|partner|-none-)$/i;
const POSIBLE_PARTNER = /posible\s+partner/i;

/**
 * ¿Esta ficha (lead, contacto, LLC o trato) es de un cliente de socio o tiene el
 * envío bloqueado? Devuelve el motivo, o '' si se le puede escribir.
 */
export function candadoSocio(r) {
  if (!r) return '';
  if (r.Bloqueo_de_envio === true || r.Bloqueo_de_envio === 'true') return 'Bloqueo de envío tildado';
  const socio = texto(r.Socio);
  if (socio && !SOCIO_PROPIO.test(socio)) return `cliente del socio ${socio}`;
  const partner = texto(r.Partner);
  if (partner && !SOCIO_PROPIO.test(partner)) return `cliente del partner ${partner}`;
  if (texto(r.Tipo_de_Contacto) === 'Partner') return 'es un partner';
  // Lo que sigue lo puede tener un prospecto de socio: ese sí se abre.
  const tipo = texto(r.Tipo);
  if (POSIBLE_PARTNER.test(tipo)) return '';
  if (/partner/i.test(tipo)) return `Tipo ${tipo}`;
  if (/^partner$/i.test(texto(r.Lead_Source))) return 'fuente Partner';
  // "Socio Tax Solutions" / "Partner: X" las pone origen-propagar a la venta de un socio.
  // "Form Socios Meta" o "Socios ..." son prospectos: /^socio\s/ no las agarra.
  const marca = etiquetas(r).find((t) => /^socio\s/i.test(t) || /^partner:/i.test(t));
  if (marca) return `etiqueta ${marca}`;
  return '';
}

// ─── FUENTES ────────────────────────────────────────────────────────────────
// Cada fuente devuelve la etiqueta con la que se reporta. `landing` reporta como
// `web`. Las landings de Lili y de socios no entran: tienen su propia plantilla y
// llegan por sus formularios.
export const FUENTES_EXTRA = ['web', 'landing', 'youtube', 'wa', 'marca', 'referido', 'chatbot'];
const ORIGEN_CTWA = 'SDR MATIAS - WP directo';
const DETECTORES = [
  ['youtube', (l, tags, fuente, landing) => tags.some((t) => /^llc apertura\s*-\s*youtube/i.test(t)) || /youtube/i.test(fuente) || /youtube/i.test(landing)],
  ['referido', (l, tags, fuente) => /^referidos?$/i.test(fuente) || tags.some((t) => /^referido/i.test(t))],
  ['chatbot', (l, tags, fuente) => /^chatbot starti/i.test(fuente)],
  ['marca', (l, tags, fuente, landing) => /^marca personal$/i.test(fuente) || /^marca personal$|^ig-dm/i.test(landing)],
  // El que le escribió a Daniel ya conversa con él: la ficha lo saltea, pero por las dudas
  // tampoco cuenta como fuente.
  ['wa', (l, tags, fuente, landing) => /^(sin origen de fuente|whatsapp \(no sabemos\)|whatsapp directo)$/i.test(fuente)
    && Boolean(l.Mobile || l.Phone) && landing !== ORIGEN_CTWA && !tags.some((t) => /whatsapp matias/i.test(t))],
  ['web', (l, tags, fuente, landing) => /^(web organic|web research|seo \/ web org|seo sat|facturaci[oó]n gratis web)/i.test(fuente) || /^(seo|web organic)/i.test(landing)],
  ['landing', (l, tags, fuente, landing) => /^landing page$/i.test(fuente)
    || (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(landing) && !/lili|partner|socio|sdr-matias|^ig-dm/i.test(landing))],
];

/** Las fuentes extra que están prendidas (vacío si el interruptor está apagado). */
export function fuentesExtraActivas(e = env) {
  if (!/^(1|true|si|sí|on)$/i.test(String(e.MATIAS_FUENTES_EXTRA_ENABLED || '').trim())) return [];
  const lista = e.MATIAS_FUENTES_EXTRA ? String(e.MATIAS_FUENTES_EXTRA).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : FUENTES_EXTRA;
  return lista.filter((f) => FUENTES_EXTRA.includes(f));
}

/** La fuente extra del lead ('web', 'youtube', 'wa', 'marca', 'referido', 'chatbot') o '' si no es de ninguna prendida. */
export function fuenteExtra(lead, activas = fuentesExtraActivas()) {
  if (!lead || !activas.length) return '';
  const tags = etiquetas(lead);
  const fuente = texto(lead.Lead_Source);
  const landing = texto(lead.Landing_Origen);
  for (const [clave, es] of DETECTORES) {
    if (activas.includes(clave) && es(lead, tags, fuente, landing)) return clave === 'landing' ? 'web' : clave;
  }
  return '';
}
