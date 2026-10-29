/*
 * MARCOS APRENDE: de contestar a escuchar.
 *
 * Decision de Ignacio (18-sep-2026), el mismo dia que apago las respuestas de
 * Marcos: "usalo para ir aprendiendo y en conocimiento". El bot ya no habla
 * con el cliente; junta lo que los clientes preguntan por WhatsApp, detecta
 * las preguntas que se repiten y que NO tienen guia ni video en el panel, y
 * de ahi salen dos cosas:
 *
 *   - una GUIA nueva para /panel/guias, con el borrador escrito, que se le
 *     manda por DM a Pablo y a Ignacio Campo para que la suban;
 *   - un VIDEO explicativo, con el tema y un guion corto, que se le manda por
 *     DM a Ignacio Navarro.
 *
 * ─── DE DONDE SALEN LAS PREGUNTAS ──────────────────────────────────────────
 *
 * Del webhook de WhatsApp, que ve pasar TODOS los mensajes al 786. Antes de
 * esto el unico rastro era el hilo (`hilo.js`), que vence a las 12 h y guarda
 * 10 mensajes, y la bitacora, que solo guarda lo que Marcos contesto. Aca se
 * guarda cada mensaje entrante en `preguntas` (blob `autorespuesta`), sin
 * frenos ni horario: lo que entra a las 3 de la manana tambien es una pregunta.
 *
 * Se guarda el mensaje crudo y nada mas. Si es cliente o lead se resuelve
 * recien en la pasada semanal, una vez por numero y con cache, para no sumar
 * una llamada a Zoho por cada mensaje que entra.
 *
 * ─── POR QUE SEMANAL Y CON PISO DE 3 ───────────────────────────────────────
 *
 * Un DM por cada pregunta suelta se ignora en una semana. Se junta una
 * semana entera (sale los lunes a las 10:00), se agrupa, y solo se propone lo que preguntaron al menos
 * MIN_PERSONAS clientes DISTINTOS. Y lo que ya se propuso una vez no se vuelve
 * a proponer: queda en `huecos-propuestos`.
 *
 * ─── LO QUE EL MODELO NO DECIDE ────────────────────────────────────────────
 *
 * El modelo agrupa, compara contra el catalogo y redacta el borrador. Nadie
 * lo publica solo: la guia la sube una persona desde /panel/portal-content,
 * y el video lo graba una persona. El DM es una propuesta, no una accion.
 */
import { getStore } from '@netlify/blobs';
import { env } from './entorno.js';
import { api as slack } from './slack.js';
import { generar } from './conversaciones/gemini.js';
import { MODELO_GEMINI } from './conversaciones/config.js';
import { contactosConTelefono } from './conversaciones/escritura.js';
import { RESPUESTAS } from './conversaciones/respuestas.js';
import { TANDAS } from './marcos-aprende-tanda1.js';

export const MIN_PERSONAS = 3;
export const DIAS_VENTANA = 7;
const TOPE_PREGUNTAS = 3000; // filas guardadas; ~3 meses al ritmo actual
const TOPE_AL_MODELO = 400; // mensajes por pasada; mas que eso es ruido
const MIN_LARGO = 12; // "ok", "dale", "si" no son preguntas

const almacen = () => getStore({ name: 'autorespuesta', consistency: 'strong' });

// Lo que YA existe en el panel (verificado en vivo el 9-sep-2026, ver
// project_panel_recursos). Si se suben guias nuevas, se agregan aca para que
// el modelo no las vuelva a proponer.
export const GUIAS_PANEL = [
  'Guía de llenado Form W-8BEN',
  '¿El reporte BOI es obligatorio?',
  'ITIN: el número fiscal para extranjeros',
  'Documentos principales de tu LLC',
  '¿Cómo retirar dinero a tu país?',
  'Reglas para proteger tu cuenta',
  'Fechas Importantes para tu LLC',
  '¿Por qué es tan importante tener un Contrato?',
  '¿Por qué es tan importante hacer y recibir una Invoice?',
];
export const VIDEOS_PANEL = [
  'Como usar Lili Bank', 'Como Abrir Lili Bank', 'Como hacer una factura',
  'Que incluye renovacion y fechas importantes', 'Documentos importantes de una LLC',
  'Como usar Stripe', 'Como abrir Stripe', 'Como usar Relay', 'Como usar Mercury',
  'Cómo abrir tu cuenta Wise paso a paso', 'LB Finanzas: abrí tu cuenta y comprá USDT paso a paso',
  'Como Usar la plataforma de START COMPANIES',
];

/**
 * Guarda un mensaje entrante. Se llama desde el webhook, para CADA mensaje al
 * 786, antes de cualquier freno. Nunca tira: si el almacen falla, el webhook
 * sigue y se pierde una fila, no una respuesta.
 */
export async function registrarPregunta(m, ahora = new Date()) {
  if (!m?.texto || String(m.texto).trim().length < MIN_LARGO) return;
  try {
    const store = almacen();
    const filas = (await store.get('preguntas', { type: 'json' })) || [];
    if (m.id && filas.some((f) => f.id === m.id)) return; // Meta reintenta el webhook
    filas.push({ id: m.id || null, numero: String(m.de || '').replace(/\D/g, ''), texto: String(m.texto).slice(0, 600), cuando: ahora.toISOString() });
    await store.setJSON('preguntas', filas.slice(-TOPE_PREGUNTAS));
  } catch (e) {
    console.log(`pregunta no registrada: ${e.message}`);
  }
}

/**
 * Cliente o lead, por numero, con cache en el blob. Una llamada a Zoho por
 * numero nuevo, en serie: el token compartido se cae con rafagas en paralelo
 * (ver project_zoho_token_compartido).
 */
async function resolverClientes(numeros, store) {
  const cache = (await store.get('clientes', { type: 'json' })) || {};
  let consultas = 0;
  for (const n of numeros) {
    if (cache[n] && Date.now() - new Date(cache[n].visto).getTime() < 30 * 86400e3) continue;
    try {
      const c = await contactosConTelefono(n);
      cache[n] = { cliente: c.length > 0, nombre: c[0]?.Full_Name || null, visto: new Date().toISOString() };
      consultas++;
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      console.log(`no se pudo resolver ${n}: ${e.message}`);
    }
  }
  await store.setJSON('clientes', cache);
  return { cache, consultas };
}

const INSTRUCCIONES = `Sos parte del equipo de Start Companies, que abre y administra LLCs en Estados Unidos
para emprendedores de Latinoamérica y España. Los clientes escriben por WhatsApp y el equipo les contesta.

Te paso mensajes de CLIENTES (gente que ya tiene su LLC con nosotros) de la última semana, agrupados por
número de teléfono, y el catálogo de lo que ya existe: las guías y los videos del panel del cliente, y las
respuestas automáticas que ya sabe dar el bot.

Tu trabajo es encontrar los HUECOS: preguntas o dudas que se repiten entre clientes DISTINTOS y que ninguna
guía, video ni respuesta cubre bien. Para cada hueco devolvé:

- "titulo_guia": el título de la guía que faltaría, en el estilo de las que ya existen (una pregunta o una
  frase corta, en español, con voseo neutro). Ejemplos del estilo: "¿Cómo retirar dinero a tu país?",
  "Reglas para proteger tu cuenta".
- "tema": una de: impuestos, bancos, stripe, facturacion, documentos, panel, renovacion, socios, direccion, otro.
- "numeros": los números de teléfono (tal cual te los paso) de los clientes que preguntaron esto. Solo
  números que REALMENTE preguntaron esto, no parecidos.
- "preguntas_ejemplo": 2 a 4 mensajes textuales de esos clientes que muestran la duda.
- "cubierto_parcialmente_por": si alguna guía, video o respuesta existente lo toca de costado, su nombre;
  si no, null.
- "necesita_video": true solo si es un paso a paso en pantalla (un formulario, una app, una configuración)
  donde ver la pantalla ayuda más que leer.
- "guion_video": si necesita_video, 4 a 6 líneas con lo que tendría que mostrar el video, en orden. Si no, "".
- "borrador": el borrador de la guía, con "para_quien" (una frase) y "secciones": 3 a 6 secciones, cada
  una con "titulo" y "puntos" (3 a 6 viñetas concretas). Escribí con los datos que ya están en el
  catálogo de respuestas; si un dato no está (un precio, un plazo, una dirección), NO lo inventes:
  escribí "[dato a confirmar]".

Reglas:
- Descartá lo que es de UN solo caso (el estado de su trámite, un monto suyo, un reclamo puntual).
- Descartá lo que ya está bien cubierto por una guía o un video existente.
- Descartá mensajes que son de LEADS (gente que todavía no compró: precios, qué estado elegir, agendar).
- Descartá lo que ya se propuso antes (te paso la lista).
- Si no hay huecos con al menos ${MIN_PERSONAS} clientes distintos, devolvé la lista vacía. Es un
  resultado válido.

Escribí en español, sin guiones largos (—).`;

const ESQUEMA = {
  type: 'object',
  properties: {
    huecos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titulo_guia: { type: 'string' },
          tema: { type: 'string', enum: ['impuestos', 'bancos', 'stripe', 'facturacion', 'documentos', 'panel', 'renovacion', 'socios', 'direccion', 'otro'] },
          numeros: { type: 'array', items: { type: 'string' } },
          preguntas_ejemplo: { type: 'array', items: { type: 'string' } },
          cubierto_parcialmente_por: { type: ['string', 'null'] },
          necesita_video: { type: 'boolean' },
          guion_video: { type: 'string' },
          borrador: {
            type: 'object',
            properties: {
              para_quien: { type: 'string' },
              secciones: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { titulo: { type: 'string' }, puntos: { type: 'array', items: { type: 'string' } } },
                  required: ['titulo', 'puntos'],
                },
              },
            },
            required: ['para_quien', 'secciones'],
          },
        },
        required: ['titulo_guia', 'tema', 'numeros', 'preguntas_ejemplo', 'cubierto_parcialmente_por', 'necesita_video', 'guion_video', 'borrador'],
      },
    },
  },
  required: ['huecos'],
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const palabrasDe = (s) => norm(s).split(/\W+/).filter((w) => w.length > 4);

/** Dos titulos son "el mismo hueco" si comparten mas del 60% de las palabras largas. */
function seParece(a, b) {
  const pa = palabrasDe(a);
  const pb = new Set(palabrasDe(b));
  if (!pa.length) return false;
  return pa.filter((w) => pb.has(w)).length / pa.length > 0.6;
}

/** El catalogo que se le muestra al modelo. */
function catalogoATexto(propuestos) {
  const guias = GUIAS_PANEL.map((g) => `- ${g}`).join('\n');
  const videos = VIDEOS_PANEL.map((v) => `- ${v}`).join('\n');
  const bot = RESPUESTAS.map((r) => `- [${r.id}] cuando: ${r.cuando}\n  dice: ${String(r.texto).replace(/\s+/g, ' ').slice(0, 420)}`)
    .join('\n');
  const ya = propuestos.length ? propuestos.map((p) => `- ${p.titulo} (${p.cuando.slice(0, 10)})`).join('\n') : '- (ninguna todavía)';
  return `GUÍAS QUE YA ESTÁN EN EL PANEL:\n${guias}\n\nVIDEOS QUE YA ESTÁN EN EL PANEL:\n${videos}\n\nRESPUESTAS QUE YA DA EL BOT (con sus datos, usalos para el borrador):\n${bot}\n\nGUÍAS YA PROPUESTAS ANTES (no repetir):\n${ya}`;
}

function mensajesATexto(porNumero) {
  return Object.entries(porNumero)
    .map(([n, ms]) => `--- cliente ${n}\n${ms.map((m) => `(${m.cuando.slice(5, 16).replace('T', ' ')}) ${m.texto.replace(/\s+/g, ' ')}`).join('\n')}`)
    .join('\n\n');
}

// ─── Slack ─────────────────────────────────────────────────────────────────

function borradorATexto(h) {
  const b = h.borrador || {};
  const secciones = (b.secciones || [])
    .map((s) => `*${s.titulo}*\n${(s.puntos || []).map((p) => `• ${p}`).join('\n')}`)
    .join('\n\n');
  return `_Para quién:_ ${b.para_quien || ''}\n\n${secciones}`;
}

function textoParaPanel(huecos, desde, hasta) {
  const partes = [
    `📚 *Marcos aprende: guías que faltan en el panel* (semana del ${desde} al ${hasta})`,
    `Estas dudas se repitieron entre clientes distintos esta semana y ninguna guía ni video del panel las cubre. Van con el borrador listo para subir desde /panel/portal-content. Si algún dato dice "[dato a confirmar]", es porque no está en ningún lado escrito: hay que completarlo antes de publicar.`,
  ];
  huecos.forEach((h, i) => {
    partes.push(
      `\n*${i + 1}. ${h.titulo_guia}*  ·  ${h.numeros.length} clientes  ·  tema: ${h.tema}${h.cubierto_parcialmente_por ? `  ·  toca de costado: ${h.cubierto_parcialmente_por}` : ''}`,
      `_Lo que preguntaron:_\n${h.preguntas_ejemplo.map((p) => `> ${p.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')}`,
      `_Borrador:_\n${borradorATexto(h)}`
    );
  });
  return partes.join('\n');
}

function textoParaVideos(huecos, desde, hasta) {
  const conVideo = huecos.filter((h) => h.necesita_video);
  if (!conVideo.length) return null;
  const partes = [
    `🎬 *Marcos aprende: videos explicativos que faltan* (semana del ${desde} al ${hasta})`,
    `Son pasos a paso en pantalla que los clientes preguntaron esta semana y que no tienen video en el panel. Cada uno con lo que tendría que mostrar, en orden.`,
  ];
  conVideo.forEach((h, i) => {
    partes.push(
      `\n*${i + 1}. ${h.titulo_guia}*  ·  ${h.numeros.length} clientes`,
      `_Lo que preguntaron:_\n${h.preguntas_ejemplo.slice(0, 2).map((p) => `> ${p.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}`,
      `_Qué mostrar:_\n${h.guion_video}`
    );
  });
  partes.push(`\nLa guía escrita de cada uno se la mandé a Pablo e Ignacio Campo, por si sirve de base para el guion.`);
  return partes.join('\n');
}

/**
 * A quien le llega cada DM. Los IDs salen del entorno si estan; si no, se
 * buscan por nombre en `users.list` (la app tiene `users:read`) y quedan en
 * cache en el blob. Asi no hay que cargar un ID a mano por cada persona nueva.
 * "Ignacio Campo" y "Ignacio Navarro" comparten nombre de pila: se busca por
 * apellido.
 */
export const DESTINATARIOS = {
  pablo: { env: 'SLACK_ID_PABLO', busca: /pablo/i },
  ignacioCampo: { env: 'SLACK_ID_IGNACIO_CAMPO', busca: /campo/i },
  ignacioNavarro: { env: 'SLACK_ID_IGNACIO_NAVARRO', busca: /navarro/i },
};

async function idsDeSlack(store) {
  const cache = (await store.get('slack-ids', { type: 'json' })) || {};
  const ids = {};
  const faltan = [];
  for (const [k, d] of Object.entries(DESTINATARIOS)) {
    ids[k] = env[d.env] || cache[k] || null;
    if (!ids[k]) faltan.push(k);
  }
  if (faltan.length) {
    try {
      const j = await slack('users.list', { limit: 500 });
      for (const k of faltan) {
        const d = DESTINATARIOS[k];
        const gente = (j.members || []).filter((u) => !u.deleted && !u.is_bot && d.busca.test(`${u.real_name || ''} ${u.profile?.display_name || ''} ${u.name || ''}`));
        if (gente.length === 1) ids[k] = cache[k] = gente[0].id;
        else console.log(`slack: ${k} tiene ${gente.length} coincidencias, no se adivina`);
      }
      await store.setJSON('slack-ids', cache);
    } catch (e) {
      console.log(`slack users.list: ${e.message}`);
    }
  }
  return ids;
}

/** Slack corta los mensajes largos: se manda en tandas de ~3800 caracteres. */
async function dm(usuario, texto) {
  if (!usuario) return { enviado: false, motivo: 'sin id de Slack' };
  const partes = [];
  let resto = texto;
  while (resto.length > 3800) {
    const corte = resto.lastIndexOf('\n\n', 3800);
    partes.push(resto.slice(0, corte > 800 ? corte : 3800));
    resto = resto.slice(corte > 800 ? corte : 3800);
  }
  partes.push(resto);
  for (const p of partes) {
    await slack('chat.postMessage', { channel: usuario, text: p, unfurl_links: false, username: 'Marcos aprende', icon_emoji: ':books:' }).catch(async (e) => {
      // Sin `chat:write.customize` Slack rechaza la firma; se reintenta sin ella.
      if (!/not_allowed_token_type|invalid_arguments/.test(e.message)) throw e;
      await slack('chat.postMessage', { channel: usuario, text: p, unfurl_links: false });
    });
  }
  return { enviado: true, partes: partes.length };
}

// ─── La pasada ─────────────────────────────────────────────────────────────

/**
 * @param {{ahora?: Date, enviar?: boolean, dias?: number}} opciones
 *   enviar=false: hace todo menos los DMs y no marca los huecos como propuestos.
 */
export async function correr({ ahora = new Date(), enviar = true, dias = DIAS_VENTANA } = {}) {
  const store = almacen();
  const desde = new Date(ahora.getTime() - dias * 86400e3);
  const todas = (await store.get('preguntas', { type: 'json' })) || [];
  const semana = todas.filter((f) => new Date(f.cuando) >= desde);
  const propuestos = (await store.get('huecos-propuestos', { type: 'json' })) || [];

  const numeros = [...new Set(semana.map((f) => f.numero).filter(Boolean))];
  const { cache, consultas } = await resolverClientes(numeros, store);

  const porNumero = {};
  for (const f of semana) {
    if (!cache[f.numero]?.cliente) continue;
    (porNumero[f.numero] ||= []).push(f);
  }
  const deClientes = Object.values(porNumero).flat().length;
  const resumen = { mensajes: semana.length, numeros: numeros.length, clientes: Object.keys(porNumero).length, mensajesDeClientes: deClientes, consultasZoho: consultas };

  if (Object.keys(porNumero).length < MIN_PERSONAS) {
    return { ...resumen, huecos: [], motivo: `solo ${Object.keys(porNumero).length} clientes escribieron, hacen falta ${MIN_PERSONAS}` };
  }

  // Si hay mas de lo que entra, se recortan los mensajes mas viejos de cada numero.
  let total = deClientes;
  while (total > TOPE_AL_MODELO) {
    const masLargo = Object.keys(porNumero).sort((a, b) => porNumero[b].length - porNumero[a].length)[0];
    porNumero[masLargo].shift();
    total--;
  }

  const { datos, uso } = await generar({
    modelo: MODELO_GEMINI,
    instrucciones: INSTRUCCIONES,
    contenido: `${catalogoATexto(propuestos)}\n\n=== MENSAJES DE CLIENTES DE LA SEMANA ===\n\n${mensajesATexto(porNumero)}`,
    esquema: ESQUEMA,
    maxTokens: 16000,
  });

  const validos = new Set(Object.keys(porNumero));
  const huecos = (datos.huecos || [])
    .map((h) => ({ ...h, numeros: [...new Set((h.numeros || []).map((n) => String(n).replace(/\D/g, '')))].filter((n) => validos.has(n)) }))
    .filter((h) => h.numeros.length >= MIN_PERSONAS)
    .filter((h) => !propuestos.some((p) => seParece(h.titulo_guia, p.titulo)))
    .filter((h) => !GUIAS_PANEL.some((g) => seParece(h.titulo_guia, g)));

  const f = (d) => d.toISOString().slice(0, 10);
  const salida = { ...resumen, uso, huecos, dms: {} };
  if (!enviar) salida.ids = await idsDeSlack(store);
  if (!huecos.length || !enviar) return salida;

  const ids = await idsDeSlack(store);
  salida.dms.pablo = await dm(ids.pablo, textoParaPanel(huecos, f(desde), f(ahora))).catch((e) => ({ enviado: false, motivo: e.message }));
  salida.dms.ignacioCampo = await dm(ids.ignacioCampo, textoParaPanel(huecos, f(desde), f(ahora))).catch((e) => ({ enviado: false, motivo: e.message }));
  const videos = textoParaVideos(huecos, f(desde), f(ahora));
  salida.dms.ignacioNavarro = videos
    ? await dm(ids.ignacioNavarro, videos).catch((e) => ({ enviado: false, motivo: e.message }))
    : { enviado: false, motivo: 'ningún hueco necesita video' };

  await store.setJSON('huecos-propuestos', [
    ...propuestos,
    ...huecos.map((h) => ({ titulo: h.titulo_guia, tema: h.tema, clientes: h.numeros.length, video: h.necesita_video, cuando: ahora.toISOString() })),
  ].slice(-300));

  return salida;
}

/**
 * Una tanda escrita a mano (ver marcos-aprende-tanda1.js). Cada una se manda
 * una sola vez; la segunda llamada con el mismo nombre no hace nada.
 */
export async function mandarTanda(nombre, { ahora = new Date() } = {}) {
  const tanda = TANDAS[nombre];
  if (!tanda) return { enviada: false, motivo: `no existe la tanda "${nombre}"` };
  const store = almacen();
  const clave = nombre === 'primera' ? 'tanda-primera' : `tanda-${nombre}`;
  const ya = await store.get(clave, { type: 'json' }).catch(() => null);
  if (ya?.enviada) return { enviada: false, motivo: `ya salio el ${ya.cuando}`, dms: ya.dms };
  const ids = await idsDeSlack(store);
  const dms = {
    pablo: await dm(ids.pablo, tanda.panel).catch((e) => ({ enviado: false, motivo: e.message })),
    ignacioCampo: await dm(ids.ignacioCampo, tanda.panel).catch((e) => ({ enviado: false, motivo: e.message })),
    ignacioNavarro: await dm(ids.ignacioNavarro, tanda.videos).catch((e) => ({ enviado: false, motivo: e.message })),
  };
  const enviada = Object.values(dms).some((d) => d.enviado);
  await store.setJSON(clave, { enviada, cuando: ahora.toISOString(), ids, dms });
  return { enviada, ids, dms };
}
