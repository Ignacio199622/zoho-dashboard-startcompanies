/*
 * ─── LOS TOQUES DE CADA PERSONA ────────────────────────────────────────────
 *
 * Ignacio (23-sep-2026): "qué cadencia de anuncios vio la persona que nos compró,
 * eso quiero saber".
 *
 * Lo que NO se puede: las impresiones. Meta no dice por persona qué anuncios le
 * mostró, ni por API ni comprando una herramienta. Lo que esas herramientas
 * llaman "el recorrido" son los CLICS, que son nuestros y sí se pueden guardar.
 *
 * El problema medido ese día: de 46 compradores por Meta en 90 días, NINGUNO
 * tenía más de un anuncio guardado (7 tenían uno solo y 39 ninguno). No es que
 * la gente toque una vez: EBIZBOOST tocó 7 veces en año y medio. Es que cada
 * visita abre una ficha nueva y el `utm_content` se pisa o se pierde, así que la
 * secuencia nunca existió.
 *
 * Esto la arma: junta todas las fichas de la misma persona (teléfono con sus
 * variantes, mail) y ordena sus toques en el tiempo, con el anuncio de cada uno.
 * Se llena SOLO HACIA ADELANTE: lo viejo sin `utm_content` no se puede
 * reconstruir, porque el fbclid no se traduce a un anuncio después del clic.
 *
 * Solo lee Zoho. Guarda en Blobs (store `toques`): una clave por persona y un
 * índice de los que compraron. No escribe nada en el CRM.
 */
import { getStore } from '@netlify/blobs';
import { get } from './conversaciones/zoho.js';

const ES_META = /meta|facebook|instagram/i;
const dig = (n) => String(n || '').replace(/\D/g, '');
const almacen = () => getStore({ name: 'toques', consistency: 'strong' });

/** El mismo teléfono guardado de las dos maneras (9 argentino, 1 mexicano). */
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

async function todos(modulo, campos, extra = '') {
  const out = [];
  let pageToken = null, page = 1;
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

/**
 * La persona, no la ficha. Una persona son todas las fichas que comparten
 * teléfono (en cualquiera de sus formas) o mail: así las 7 fichas de EBIZBOOST
 * son un solo recorrido y no siete comienzos.
 */
const clavesDe = (r) => {
  const out = new Set();
  for (const v of [...variantesDe(r.Mobile), ...variantesDe(r.Phone)]) out.add(`t:${v}`);
  const m = (r.Email || '').trim().toLowerCase();
  if (m.includes('@')) out.add(`m:${m}`);
  return [...out];
};

/** Un toque es una llegada con algo que diga por dónde entró. */
function toqueDe(r, origen) {
  const anuncio = r.utm_content || r.Anuncio || null;
  const porDonde = r.Landing_Origen || r.Calendario || null;
  if (!anuncio && !porDonde && !r.Campa_a_Meta && !r.leadchain0__Social_Lead_ID) return null;
  return {
    fecha: r.Created_Time,
    origen,                                   // 'lead' | 'contacto'
    anuncio,
    campana: r.Campa_a_Meta || r.utm_campaign || null,
    porDonde,
    canal: r.Lead_Source || null,
    formulario: r.leadchain0__Social_Lead_ID ? 'form de Meta' : null,
    ficha: r.id,
  };
}

/** Dos llegadas del mismo anuncio el mismo día son una sola. */
const sinRepetir = (toques) => {
  const visto = new Set();
  return toques.filter((t) => {
    const k = `${String(t.fecha).slice(0, 10)}|${t.anuncio || ''}|${t.porDonde || ''}`;
    if (visto.has(k)) return false;
    visto.add(k);
    return true;
  });
};

export async function pasadaToques({ guardar = true } = {}) {
  const desde = Date.now();
  const CL = 'id,Full_Name,Mobile,Phone,Email,Created_Time,Lead_Source,Landing_Origen,Calendario,utm_source,utm_campaign,utm_content,Campa_a_Meta,Anuncio,fbc,fbclid,leadchain0__Social_Lead_ID';
  const leads = await todos('Leads', CL, '&converted=both');
  const contactos = await todos('Contacts', 'id,Full_Name,Mobile,Phone,Email,Lead_Source,Landing_Origen,Calendario,utm_campaign,utm_content,Campa_a_Meta,Anuncio,leadchain0__Social_Lead_ID,Account_Name');
  const tratos = await todos('Deals', 'id,Deal_Name,Type,Stage,Amount,Created_Time,Contact_Name,Lead_Source,utm_content,Anuncio,Partner');

  // 1. Los toques, agrupados por persona.
  const personas = new Map();           // clave → { nombre, toques[], claves[] }
  // El CONTACTO no genera toque propio: Zoho no le devuelve `Created_Time` por
  // ninguna vía (ni fields=, ni search, ni COQL) y además su origen es una copia
  // del lead, así que contarlo duplicaba el mismo anuncio con fecha vacía. Sirve
  // para unir identidad (teléfono/mail) y para colgarle la compra.
  const sumar = (r, origen) => {
    const t = origen === 'lead' ? toqueDe(r, origen) : null;
    const claves = clavesDe(r);
    if (!claves.length) return;
    // Una persona puede aparecer con varias claves: se unifican quedándose con
    // la primera que ya exista, para no partir el recorrido en dos.
    const existente = claves.map((k) => personas.get(k)).find(Boolean);
    const p = existente || { nombre: r.Full_Name || '', toques: [], claves: [], compras: [] };
    for (const k of claves) if (!p.claves.includes(k)) { p.claves.push(k); personas.set(k, p); }
    if (!p.nombre && r.Full_Name) p.nombre = r.Full_Name;
    if (t) p.toques.push(t);
  };
  for (const l of leads) sumar(l, 'lead');
  for (const c of contactos) sumar(c, 'contacto');

  // 2. Las compras, para saber en qué terminó el recorrido.
  const porIdContacto = new Map();
  for (const c of contactos) for (const k of clavesDe(c)) { const p = personas.get(k); if (p) porIdContacto.set(c.id, p); }
  for (const d of tratos) {
    const p = porIdContacto.get(d.Contact_Name?.id);
    if (!p) continue;
    p.compras.push({ fecha: d.Created_Time, nombre: d.Deal_Name, usd: Number(d.Amount) || 0, tipo: d.Type || null, socio: d.Partner || null, etapa: d.Stage });
  }

  // 3. Ordenar y guardar. Se guarda una clave por persona (la primera, estable)
  // y el resto apunta a esa, para poder buscarla por teléfono o por mail.
  const unicas = [...new Set(personas.values())];
  const conRecorrido = [];
  for (const p of unicas) {
    p.toques = sinRepetir(p.toques.sort((a, b) => (a.fecha < b.fecha ? -1 : 1)));
    p.compras.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    const anuncios = [...new Set(p.toques.map((t) => t.anuncio).filter(Boolean))];
    p.resumen = { toques: p.toques.length, anuncios: anuncios.length, compro: p.compras.length > 0, usd: p.compras.reduce((n, c) => n + c.usd, 0) };
    if (p.toques.length) conRecorrido.push(p);
  }
  const compradores = conRecorrido.filter((p) => p.resumen.compro).sort((a, b) => (a.compras[0].fecha < b.compras[0].fecha ? 1 : -1));
  const resumen = {
    corrida: new Date().toISOString(),
    personas: unicas.length,
    conRecorrido: conRecorrido.length,
    compradores: compradores.length,
    compradoresConVariosAnuncios: compradores.filter((p) => p.resumen.anuncios > 1).length,
    compradoresConUnAnuncio: compradores.filter((p) => p.resumen.anuncios === 1).length,
    compradoresSinAnuncio: compradores.filter((p) => p.resumen.anuncios === 0).length,
    segundos: 0,
  };
  if (guardar) {
    const store = almacen();
    // El índice es lo que mira la página: los últimos 300 compradores con su recorrido.
    await store.setJSON('compradores', compradores.slice(0, 300).map((p) => ({ nombre: p.nombre, claves: p.claves, resumen: p.resumen, toques: p.toques, compras: p.compras })));
    await store.setJSON('resumen', resumen);
    // Y una clave por persona, para buscarla suelta por teléfono o mail.
    for (const p of conRecorrido) {
      const ficha = { nombre: p.nombre, resumen: p.resumen, toques: p.toques, compras: p.compras };
      await store.setJSON(`p:${p.claves[0]}`, ficha).catch(() => {});
    }
  }
  resumen.segundos = Math.round((Date.now() - desde) / 1000);
  return { resumen, compradores };
}

/** Busca el recorrido de una persona por teléfono o mail. */
export async function recorridoDe({ telefono, email }) {
  const store = almacen();
  const claves = [...variantesDe(telefono).map((v) => `t:${v}`), email ? `m:${String(email).trim().toLowerCase()}` : null].filter(Boolean);
  for (const k of claves) {
    const j = await store.get(`p:${k}`, { type: 'json' }).catch(() => null);
    if (j) return j;
  }
  // Puede estar guardada bajo otra de sus claves: se busca en el índice.
  const idx = (await store.get('compradores', { type: 'json' }).catch(() => null)) || [];
  return idx.find((p) => p.claves.some((k) => claves.includes(k))) || null;
}
