/*
 * DE QUE ANUNCIO VINO UN WHATSAPP QUE ENTRO POR EL BOTON DE LA PAGINA.
 *
 * Cuando alguien toca "WhatsApp" en la pagina de Facebook / el perfil de
 * Instagram de Start Companies (desde un anuncio o desde un post), Meta manda
 * el chat al numero principal de la pagina (el 786 de Zoho desde el 21-sep-2026)
 * y Zoho guarda el primer mensaje asi:
 *
 *     https://fb.me/8b0ZUnkMm \n\n¡Hola! Quiero más información
 *     https://www.instagram.com/p/DRU3ObzjNp3/ \n\n¡Hola! Quiero más información
 *
 * El link es el post. No viene el id del anuncio, pero el post SI identifica al
 * creativo: fb.me redirige a story.php?story_fbid=<post> y ese numero es la cola
 * del `effective_object_story_id` del anuncio; el permalink de Instagram esta
 * en `instagram_permalink_url`. Esto resuelve link -> anuncio y devuelve lo que
 * Zoho necesita para atribuir (utm_content / utm_campaign / fuente) y para
 * elegir la cadencia (Lili, Socios, Relay o LLC), que en Zoho sale de la
 * etiqueta que pone `leadsWhatsapp` al crear el lead.
 *
 *   POST { texto, telefono }   texto = el primer mensaje entero; el telefono
 *                              desempata entre los conjuntos por pais
 *   GET  ?url=...&pais=CO      para probar a mano
 *
 * Respuesta: { encontrado, src (fb|ig), med (paid|organico), post, anuncio:
 *   { id, nombre, conjunto, campana_id, campana, titulo, estado }, cadencia,
 *   candidatos }
 *
 * LA TABLA DE ANUNCIOS vive en Blobs (store `wa-anuncios`, clave `tabla`). La
 * primera vez se baja entera (10 paginas de 150) y despues se completa con
 * `updated_since` (1 llamada), solo cuando un link no matchea y la tabla tiene
 * mas de 20 minutos. Esto NO pasa por el gobernador de 3qs-work: por eso el
 * techo es chico (a lo sumo 3 llamadas por hora) y queda anotado en la bitacora.
 * Sin META_ADS_TOKEN la tabla no se actualiza y solo sirve lo que ya esta.
 */
import { getStore } from '@netlify/blobs';

const GRAPH = 'https://graph.facebook.com/v21.0';
const CUENTA = 'act_1753889281707689';
const CAMPOS = 'id,name,effective_status,updated_time,adset{id,name},campaign{id,name},creative{title,effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,object_story_spec{video_data{video_id}}}';
const MIN_ENTRE_REFRESCOS = 20 * 60 * 1000;
const MAX_REFRESCOS_HORA = 3;
// Con un User-Agent de Chrome completo facebook.com/share contesta 400; con uno pelado redirige.
const UA = 'Mozilla/5.0';

const almacen = () => getStore({ name: 'wa-anuncios', consistency: 'strong' });

// ---------- el link ----------
const HOSTS = /^(?:www\.|m\.|l\.)?(?:fb\.me|fb\.watch|facebook\.com|instagram\.com)$/i;

export function extraerLink(texto) {
  for (const m of String(texto || '').matchAll(/https?:\/\/[^\s<>"']+/g)) {
    try {
      const u = new URL(m[0].replace(/[.,;)\]]+$/, ''));
      if (HOSTS.test(u.hostname)) return u.toString();
    } catch { /* no era una URL */ }
  }
  return null;
}

// Sigue redirecciones a mano y junta todas las URLs por las que paso: el id
// puede estar en cualquiera (fb.me -> story.php; share/r -> reel/<id>?...).
// Va con GET: a un HEAD facebook.com/share contesta 400. Si la ultima respuesta
// es una pagina (200), se le buscan los ids adentro del HTML (og:url, video_id).
async function seguir(url) {
  const vistas = [url];
  vistas.estados = [];
  let actual = url;
  for (let i = 0; i < 5; i++) {
    let r;
    try {
      r = await fetch(actual, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'es' }, signal: AbortSignal.timeout(8000) });
    } catch (e) { vistas.estados.push('error ' + (e?.name || e)); break; }
    vistas.estados.push(r.status);
    const loc = r.headers.get('location');
    if (loc && r.status >= 300 && r.status < 400) {
      actual = new URL(loc, actual).toString();
      vistas.push(actual);
      continue;
    }
    if (r.status === 200) {
      try {
        const html = (await r.text()).slice(0, 400000);
        for (const m of html.matchAll(/(?:story_fbid|fbid|video_id|reel_id)(?:=|\\?":\\?")(\d{8,})/g)) vistas.push(`https://www.facebook.com/videos/${m[1]}`);
        const og = html.match(/property="og:url"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="og:url"/);
        if (og) vistas.push(og[1].replace(/&amp;/g, '&'));
      } catch { /* sin cuerpo, con lo que hay alcanza */ }
    }
    break;
  }
  return vistas;
}

export function idsDeUrls(urls) {
  const ids = { fb: new Set(), ig: new Set() };
  for (const u of urls) {
    let p;
    try { p = new URL(u); } catch { continue; }
    if (/instagram\.com$/i.test(p.hostname)) {
      const m = p.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/);
      if (m) ids.ig.add(m[1]);
      continue;
    }
    const q = p.searchParams;
    for (const k of ['story_fbid', 'fbid', 'v', 'id_post']) if (/^\d{6,}$/.test(q.get(k) || '')) ids.fb.add(q.get(k));
    for (const m of p.pathname.matchAll(/\/(?:posts|videos|reel|reels|photos|watch)\/(\d{6,})/g)) ids.fb.add(m[1]);
    const m2 = p.pathname.match(/\/(\d{8,})\/?$/);
    if (m2) ids.fb.add(m2[1]);
  }
  return { fb: [...ids.fb], ig: [...ids.ig] };
}

// ---------- la tabla ----------
function fila(a) {
  const c = a.creative || {};
  const story = String(c.effective_object_story_id || '');
  const ig = String(c.instagram_permalink_url || '').match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/);
  return {
    id: a.id, nombre: a.name, estado: a.effective_status, actualizado: a.updated_time,
    conjunto: a.adset?.name || '', conjunto_id: a.adset?.id || '',
    campana_id: a.campaign?.id || '', campana: a.campaign?.name || '',
    titulo: c.title || '',
    post: story.includes('_') ? story.split('_')[1] : story,
    ig_media: c.effective_instagram_media_id || '', ig_code: ig ? ig[1] : '',
    video: c.object_story_spec?.video_data?.video_id || '',
  };
}

async function leerTabla() {
  return (await almacen().get('tabla', { type: 'json' })) || { actualizado: null, completa: false, anuncios: {} };
}

async function refrescar(tabla, motivo) {
  const token = process.env.META_ADS_TOKEN;
  if (!token) return { ok: false, motivo: 'sin META_ADS_TOKEN' };
  const ahora = Date.now();
  const bit = (await almacen().get('bitacora', { type: 'json' })) || { refrescos: [] };
  const ultimaHora = bit.refrescos.filter(r => ahora - new Date(r.cuando).getTime() < 3600e3);
  if (ultimaHora.length >= MAX_REFRESCOS_HORA) return { ok: false, motivo: 'techo por hora' };
  if (tabla.actualizado && ahora - new Date(tabla.actualizado).getTime() < MIN_ENTRE_REFRESCOS) return { ok: false, motivo: 'tabla fresca' };

  let llamadas = 0, nuevos = 0;
  const base = new URLSearchParams({ access_token: token, fields: CAMPOS, limit: '150' });
  if (tabla.completa && tabla.actualizado) base.set('updated_since', String(Math.floor((new Date(tabla.actualizado).getTime() - 86400e3) / 1000)));
  let url = `${GRAPH}/${CUENTA}/ads?${base}`;
  const desde = new Date(ahora).toISOString();
  for (let i = 0; i < 12 && url; i++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    llamadas++;
    const j = await r.json();
    if (j.error) {
      bit.refrescos.push({ cuando: desde, motivo, llamadas, error: j.error.message });
      await almacen().setJSON('bitacora', { refrescos: bit.refrescos.slice(-50) });
      return { ok: false, motivo: 'Meta: ' + j.error.message, llamadas };
    }
    for (const a of j.data || []) { if (!tabla.anuncios[a.id]) nuevos++; tabla.anuncios[a.id] = fila(a); }
    url = j.paging?.next || null;
  }
  tabla.completa = tabla.completa || !url;
  tabla.actualizado = desde;
  await almacen().setJSON('tabla', tabla);
  bit.refrescos.push({ cuando: desde, motivo, llamadas, nuevos, total: Object.keys(tabla.anuncios).length });
  await almacen().setJSON('bitacora', { refrescos: bit.refrescos.slice(-50) });
  return { ok: true, llamadas, nuevos };
}

// ---------- el match ----------
const PAISES = [
  ['54', 'AR', /\b(AR|ARG|ARGENTINA)\b/i], ['57', 'CO', /\b(CO|COL|COLOMBIA)\b/i], ['52', 'MX', /\b(MX|MEX|MEXICO|MÉXICO)\b/i],
  ['34', 'ES', /\b(ES|ESP|ESPAÑA|ESPANA)\b/i], ['56', 'CL', /\b(CL|CHI|CHILE)\b/i], ['593', 'EC', /\b(EC|ECU|ECUADOR)\b/i],
  ['51', 'PE', /\b(PE|PERU|PERÚ)\b/i], ['598', 'UY', /\b(UY|URU|URUGUAY)\b/i], ['591', 'BO', /\b(BO|BOL|BOLIVIA)\b/i],
  ['595', 'PY', /\b(PY|PAR|PARAGUAY)\b/i], ['58', 'VE', /\b(VE|VEN|VENEZUELA)\b/i], ['1', 'US', /\b(US|USA|EEUU)\b/i],
];
export function paisDeTelefono(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  for (const [pref, iso] of PAISES.sort((a, b) => b[0].length - a[0].length)) if (d.startsWith(pref)) return iso;
  return '';
}

export function cadenciaDe(campana, conjunto) {
  const s = `${campana} ${conjunto}`;
  if (/lili/i.test(s)) return 'lili';
  if (/partner|socio/i.test(s)) return 'socios';
  if (/relay/i.test(s)) return 'relay';
  return 'llc';
}

export function elegir(candidatos, pais) {
  if (!candidatos.length) return null;
  const re = pais ? PAISES.find(p => p[1] === pais)?.[2] : null;
  const delPais = re ? candidatos.filter(c => re.test(c.conjunto)) : [];
  const orden = xs => [...xs].sort((a, b) => (b.estado === 'ACTIVE') - (a.estado === 'ACTIVE') || (b.id > a.id ? 1 : -1));
  return orden(delPais.length ? delPais : candidatos)[0];
}

function buscar(tabla, ids) {
  const filas = Object.values(tabla.anuncios);
  const out = [];
  for (const f of filas) {
    if (ids.fb.some(id => f.post === id || f.video === id || f.ig_media === id)) out.push(f);
    else if (ids.ig.some(code => f.ig_code === code)) out.push(f);
  }
  return out;
}

// ---------- el handler ----------
async function leerEntrada(req) {
  const u = new URL(req.url);
  if (req.method === 'GET') return { url: u.searchParams.get('url'), texto: u.searchParams.get('texto'), telefono: u.searchParams.get('telefono'), pais: u.searchParams.get('pais'), refrescar: u.searchParams.get('refrescar') };
  const crudo = await req.text();
  try { return JSON.parse(crudo); } catch { /* Deluge manda form-encoded */ }
  return Object.fromEntries(new URLSearchParams(crudo));
}

export default async (req) => {
  const e = await leerEntrada(req);
  const tabla = await leerTabla();
  if (e.refrescar) {
    if (req.headers.get('x-clave') !== process.env.CALCOM_SECRET) return new Response('clave inválida', { status: 401 });
    tabla.actualizado = null;
    return Response.json(await refrescar(tabla, 'pedido a mano'));
  }
  const link = e.url || extraerLink(e.texto);
  if (!link) return Response.json({ encontrado: false, motivo: 'sin link de Facebook / Instagram', src: '', med: '' });

  const urls = await seguir(link);
  const ids = idsDeUrls(urls);
  const src = /instagram\.com/i.test(urls.join(' ')) ? 'ig' : 'fb';
  let candidatos = buscar(tabla, ids);
  let refresco = null;
  if (!candidatos.length && (ids.fb.length || ids.ig.length)) {
    refresco = await refrescar(tabla, `sin match ${link}`);
    if (refresco.ok) candidatos = buscar(tabla, ids);
  }
  const pais = (e.pais || paisDeTelefono(e.telefono) || '').toUpperCase();
  const anuncio = elegir(candidatos, pais);
  const res = {
    encontrado: Boolean(anuncio), src, med: anuncio ? 'paid' : 'organico',
    link, url_final: urls[urls.length - 1], estados: urls.estados, post: ids.fb[0] || ids.ig[0] || '', pais,
    anuncio: anuncio ? { id: anuncio.id, nombre: anuncio.nombre, conjunto: anuncio.conjunto, campana_id: anuncio.campana_id, campana: anuncio.campana, titulo: anuncio.titulo, estado: anuncio.estado } : null,
    cadencia: anuncio ? cadenciaDe(anuncio.campana, anuncio.conjunto) : '',
    candidatos: candidatos.map(c => ({ id: c.id, conjunto: c.conjunto, estado: c.estado })),
    tabla: { anuncios: Object.keys(tabla.anuncios).length, actualizado: tabla.actualizado, refresco },
  };
  return Response.json(res);
};

export const config = { path: '/.netlify/functions/wa-anuncio' };
