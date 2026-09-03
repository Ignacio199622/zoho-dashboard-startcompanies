// Escribe el analisis de marketing en su base de Notion.
//
// La base se crea sola la primera vez y su id queda en BIBLIOTECA/MARKETING_DB.
// Cada corrida agrega lo que no estaba: nunca pisa una fila que alguien ya tocó,
// misma regla que el resto del proyecto.
import { env, exigir } from './entorno.js';

const BASE = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

const TIPOS = ['Objeción', 'Hook orgánico', 'Ads frío', 'Blog', 'YouTube'];

function cabeceras() {
  exigir('NOTION_TOKEN');
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json',
  };
}

async function pedir(metodo, path, cuerpo) {
  const r = await fetch(`${BASE}/${path}`, {
    method: metodo,
    headers: cabeceras(),
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Notion ${path}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 250)}`);
  return j;
}

const texto = (prop) =>
  ((prop?.title || prop?.rich_text || []).map((t) => t.plain_text).join('') || '').trim();

const clave = (s) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const rt = (v) => ({ rich_text: [{ text: { content: String(v || '').slice(0, 1900) } }] });

export async function crearBase(paginaMadre) {
  const j = await pedir('POST', 'databases', {
    parent: { type: 'page_id', page_id: paginaMadre },
    icon: { type: 'emoji', emoji: '📣' },
    title: [{ type: 'text', text: { content: 'Marketing' } }],
    description: [{ type: 'text', text: { content: 'Objeciones reales y contenido escrito contra ellas. Lo genera el analizador a partir de las llamadas de venta.' } }],
    properties: {
      'Título': { title: {} },
      Tipo: { select: { options: TIPOS.map((n) => ({ name: n })) } },
      Cuerpo: { rich_text: {} },
      CTA: { rich_text: {} },
      'Por qué': { rich_text: {} },
      Veces: { number: {} },
      Estado: {
        select: {
          options: [
            { name: 'Por revisar', color: 'yellow' },
            { name: 'Aprobado', color: 'green' },
            { name: 'Descartado', color: 'gray' },
          ],
        },
      },
      Mes: { select: { options: [] } },
      Generado: { date: {} },
    },
  });
  return j.id;
}

/** La opción del select tiene que existir antes de escribir la primera fila del mes. */
async function asegurarMes(mes) {
  if (!mes) return;
  const db = await pedir('GET', `databases/${env.MARKETING_DB}`);
  const opciones = db.properties?.Mes?.select?.options || [];
  if (opciones.some((o) => o.name === mes)) return;
  await pedir('PATCH', `databases/${env.MARKETING_DB}`, {
    properties: { Mes: { select: { options: [...opciones.map((o) => ({ name: o.name })), { name: mes }] } } },
  });
}

async function existentes() {
  const out = new Set();
  let cursor;
  do {
    const j = await pedir('POST', `databases/${env.MARKETING_DB}/query`, { page_size: 100, start_cursor: cursor });
    for (const p of j.results) out.add((p.properties['Mes']?.select?.name || '') + '|' + clave(texto(p.properties['Título'])));
    cursor = j.next_cursor;
  } while (cursor);
  return out;
}

/** Aplana el JSON del analizador a filas de la base. */
function aFilas(m) {
  const filas = [];
  for (const o of m.objeciones || []) {
    filas.push({
      titulo: o.objecion,
      tipo: 'Objeción',
      // Sin prefijo: la etiqueta "Qué hay detrás" ya la pone la web.
      cuerpo: o.que_hay_detras,
      cta: o.como_responderla,
      porQue: `Aparece en ${o.veces} llamadas del período analizado.`,
      veces: o.veces,
    });
  }
  const mapa = [['organico', 'Hook orgánico'], ['ads_frio', 'Ads frío'], ['blogs', 'Blog'], ['youtube', 'YouTube']];
  for (const [campo, tipo] of mapa) {
    for (const p of m[campo] || []) {
      filas.push({
        titulo: p.hook || p.titulo,
        tipo,
        cuerpo: p.cuerpo,
        cta: p.cta,
        porQue: p.por_que,
      });
    }
  }
  return filas;
}

export async function subirMarketing(m) {
  exigir('MARKETING_DB');
  const ya = await existentes();
  const fecha = String(m.generado || '').slice(0, 10);
  // La misma objeción puede volver el mes que viene: por eso la clave lleva el mes.
  const mes = m.etiqueta || '';
  await asegurarMes(mes);
  let nuevas = 0, repetidas = 0;

  for (const f of aFilas(m)) {
    if (ya.has(mes + '|' + clave(f.titulo))) { repetidas++; continue; }
    await pedir('POST', 'pages', {
      parent: { database_id: env.MARKETING_DB },
      properties: {
        'Título': { title: [{ text: { content: String(f.titulo).slice(0, 1900) } }] },
        Tipo: { select: { name: f.tipo } },
        Cuerpo: rt(f.cuerpo),
        CTA: rt(f.cta),
        'Por qué': rt(f.porQue),
        ...(f.veces ? { Veces: { number: f.veces } } : {}),
        ...(mes ? { Mes: { select: { name: mes } } } : {}),
        Estado: { select: { name: 'Por revisar' } },
        ...(fecha ? { Generado: { date: { start: fecha } } } : {}),
      },
    });
    ya.add(mes + '|' + clave(f.titulo));
    nuevas++;
    await new Promise((s) => setTimeout(s, 320));
  }

  console.log(`Notion: ${nuevas} filas nuevas · ${repetidas} ya estaban`);
  return { nuevas, repetidas };
}
