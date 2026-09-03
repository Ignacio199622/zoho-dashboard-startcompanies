// Cliente de Notion para el tablero de tareas del equipo.
//
// La base vive en Start Companies HQ -> "Tareas del equipo." -> base "Tareas".
// La integracion se llama "Agente de tareas" y solo ve esa pagina y sus hijas.
import { env, exigir } from './entorno.js';

const BASE = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

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
  if (!r.ok) throw new Error(`Notion ${path}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

const texto = (prop) =>
  ((prop?.title || prop?.rich_text || []).map((t) => t.plain_text).join('') || '').trim();

/**
 * Las tareas del tablero contra las que se deduplica: todo lo abierto, mas lo
 * ya hecho de los ultimos `dias`. Sin ese segundo grupo, una tarea que se
 * cierra y se vuelve a mencionar en una reunion se crea de nuevo.
 */
export async function tareasRecientes(dias = 60) {
  exigir('NOTION_DB');
  const corte = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  const out = [];
  let cursor;
  do {
    const j = await pedir('POST', `databases/${env.NOTION_DB}/query`, {
      page_size: 100,
      start_cursor: cursor,
      filter: {
        or: [
          { property: 'Estado', select: { does_not_equal: 'Hecha' } },
          { property: 'Fecha', date: { on_or_after: corte } },
        ],
      },
    });
    for (const p of j.results) {
      out.push({
        id: p.id,
        tarea: texto(p.properties['Tarea']),
        responsable: p.properties['Responsable']?.select?.name || null,
        estado: p.properties['Estado']?.select?.name || null,
      });
    }
    cursor = j.next_cursor;
  } while (cursor);
  return out;
}

/** Crea una fila. Los select tienen que existir ya en el esquema. */
export async function crearTarea({ tarea, responsable, area, urgencia, contexto, reunion, fecha }) {
  return pedir('POST', 'pages', {
    parent: { database_id: env.NOTION_DB },
    properties: {
      Tarea: { title: [{ text: { content: tarea.slice(0, 1900) } }] },
      Responsable: { select: { name: responsable } },
      'Área': { select: { name: area } },
      Urgencia: { select: { name: urgencia } },
      // Entran abiertas: Ignacio decidio no revisarlas una por una (31-ago).
      Estado: { select: { name: 'Abierta' } },
      Contexto: { rich_text: [{ text: { content: (contexto || '').slice(0, 1900) } }] },
      ...(reunion ? { 'Reunión': { url: reunion } } : {}),
      ...(fecha ? { Fecha: { date: { start: fecha } } } : {}),
    },
  });
}

/** Marca hecha una tarea que en la reunion se dijo que ya estaba resuelta. */
export async function marcarHecha(id, nota) {
  const props = { Estado: { select: { name: 'Hecha' } } };
  if (nota) props.Contexto = { rich_text: [{ text: { content: nota.slice(0, 1900) } }] };
  return pedir('PATCH', `pages/${id}`, { properties: props });
}

/** Una decision que no es tarea: queda registrada para no perderse en la transcripcion. */
export async function crearDecision({ decision, tema, porQue, quien, reunion, fecha }) {
  exigir('DECISIONES_DB');
  return pedir('POST', 'pages', {
    parent: { database_id: env.DECISIONES_DB },
    properties: {
      'Decisión': { title: [{ text: { content: decision.slice(0, 1900) } }] },
      Tema: { select: { name: tema } },
      'Por qué': { rich_text: [{ text: { content: (porQue || '').slice(0, 1900) } }] },
      'Quién la tomó': { rich_text: [{ text: { content: (quien || '').slice(0, 200) } }] },
      ...(reunion ? { 'Reunión': { url: reunion } } : {}),
      ...(fecha ? { Fecha: { date: { start: fecha } } } : {}),
    },
  });
}

/** Las decisiones ya registradas, para no repetirlas. */
export async function decisionesRecientes(dias = 90) {
  exigir('DECISIONES_DB');
  const corte = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  const j = await pedir('POST', `databases/${env.DECISIONES_DB}/query`, {
    page_size: 100,
    filter: { property: 'Fecha', date: { on_or_after: corte } },
  });
  return (j.results || []).map((p) => texto(p.properties['Decisión'])).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Biblioteca: como se hace cada cosa. Se llena con lo que alguien EXPLICA en
// una reunion. A diferencia de las tareas, una ficha no se cierra: se acumula.
// Regla igual que en el agente de llamadas: no se pisa nada. Una explicacion
// nueva sobre un tema ya fichado se agrega al cuerpo de la pagina con su fecha.
// ---------------------------------------------------------------------------

/** Las fichas que ya existen, para que el modelo sepa cual ampliar. */
export async function fichasRecientes() {
  exigir('BIBLIOTECA_DB');
  const out = [];
  let cursor;
  do {
    const j = await pedir('POST', `databases/${env.BIBLIOTECA_DB}/query`, {
      page_size: 100,
      start_cursor: cursor,
    });
    for (const p of j.results) {
      out.push({
        id: p.id,
        tema: texto(p.properties['Tema']),
        cuando: texto(p.properties['Cuándo aplica']),
        veces: p.properties['Veces explicado']?.number || 1,
      });
    }
    cursor = j.next_cursor;
  } while (cursor);
  return out;
}

export async function crearFicha({ tema, area, como, cuando, quien, reunion, fecha }) {
  exigir('BIBLIOTECA_DB');
  return pedir('POST', 'pages', {
    parent: { database_id: env.BIBLIOTECA_DB },
    properties: {
      Tema: { title: [{ text: { content: tema.slice(0, 1900) } }] },
      'Área': { select: { name: area } },
      'Cómo se hace': { rich_text: [{ text: { content: (como || '').slice(0, 1900) } }] },
      'Cuándo aplica': { rich_text: [{ text: { content: (cuando || '').slice(0, 1900) } }] },
      'Quién lo explicó': { rich_text: [{ text: { content: (quien || '').slice(0, 200) } }] },
      'Veces explicado': { number: 1 },
      Estado: { select: { name: 'Por revisar' } },
      ...(reunion ? { 'Reunión': { url: reunion } } : {}),
      ...(fecha ? { Actualizado: { date: { start: fecha } } } : {}),
    },
    children: bloquesDeVersion({ como, quien, fecha, reunion }),
  });
}

/**
 * Una explicacion nueva de algo ya fichado. No toca "Cómo se hace" (lo que ya
 * estaba escrito gana): suma una version al cuerpo y corre la fecha.
 */
export async function ampliarFicha(ficha, { como, quien, reunion, fecha }) {
  await pedir('PATCH', `blocks/${ficha.id}/children`, {
    children: bloquesDeVersion({ como, quien, fecha, reunion }),
  });
  return pedir('PATCH', `pages/${ficha.id}`, {
    properties: {
      'Veces explicado': { number: (ficha.veces || 1) + 1 },
      ...(fecha ? { Actualizado: { date: { start: fecha } } } : {}),
    },
  });
}

function bloquesDeVersion({ como, quien, fecha, reunion }) {
  const cabeza = `${fecha || 'sin fecha'} · lo explicó ${quien || 'sin datos'}`;
  return [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: {
        rich_text: reunion
          ? [{ type: 'text', text: { content: cabeza, link: { url: reunion } } }]
          : [{ type: 'text', text: { content: cabeza } }],
      },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: (como || '').slice(0, 1900) } }] },
    },
  ];
}
