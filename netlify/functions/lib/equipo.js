// Quien es quien, leido de Notion en cada corrida.
//
// El roster no vive en el codigo a proposito: cuando entra alguien nuevo se
// agrega una fila en la tabla "Equipo y roles" y el agente se entera solo, sin
// tocar nada ni deployar.
import { env, exigir } from './entorno.js';

const H = () => ({
  Authorization: `Bearer ${env.NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
});

const texto = (p) => ((p?.title || p?.rich_text || []).map((t) => t.plain_text).join('') || '').trim();

/** Las personas activas, con su area y como reconocerlas en una llamada. */
export async function equipo() {
  exigir('NOTION_TOKEN', 'EQUIPO_DB');
  const r = await fetch(`https://api.notion.com/v1/databases/${env.EQUIPO_DB}/query`, {
    method: 'POST',
    headers: H(),
    body: JSON.stringify({
      page_size: 100,
      filter: { property: 'Activo', checkbox: { equals: true } },
    }),
  });
  const j = await r.json();
  if (!j.results) throw new Error(`Notion equipo: ${JSON.stringify(j).slice(0, 200)}`);
  return j.results.map((p) => ({
    nombre: texto(p.properties['Nombre']),
    area: p.properties['Área']?.select?.name || '',
    hace: texto(p.properties['Qué hace']),
    señas: texto(p.properties['Cómo reconocerlo en la call']),
    reportaA: texto(p.properties['Reporta a']),
  })).filter((p) => p.nombre);
}

/** El bloque de texto que va en el prompt. */
export function rosterATexto(gente) {
  const lineas = gente.map((p) => {
    const partes = [`- **${p.nombre}**`];
    if (p.area) partes.push(` (${p.area}${p.reportaA ? `, reporta a ${p.reportaA}` : ''})`);
    partes.push(`: ${p.hace}`);
    if (p.señas) partes.push(` ${p.señas}`);
    return partes.join('');
  });
  return lineas.join('\n');
}

/**
 * Deja el select "Responsable" del tablero con todos los del equipo.
 * Sin esto, una persona nueva hace fallar la escritura de su primera tarea.
 */
export async function sincronizarResponsables(nombres) {
  exigir('NOTION_DB');
  const db = await (await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DB}`, { headers: H() })).json();
  // Si alguien renombra la columna en la UI, `properties.Responsable` desaparece y el
  // PATCH de abajo la volvia a crear vacia, partiendo el tablero en dos. Mejor cortar.
  if (!db.properties?.['Responsable']) {
    throw new Error(
      'La base de Tareas no tiene la columna "Responsable" (alguien la renombro en Notion). ' +
        'Columnas actuales: ' + Object.keys(db.properties || {}).join(', ')
    );
  }
  const actuales = db.properties['Responsable'].select?.options || [];
  const tiene = new Set(actuales.map((o) => o.name));
  const faltan = [...nombres, 'Sin asignar'].filter((n) => !tiene.has(n));
  if (!faltan.length) return [];
  await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DB}`, {
    method: 'PATCH',
    headers: H(),
    body: JSON.stringify({
      properties: { Responsable: { select: { options: [...actuales, ...faltan.map((name) => ({ name }))] } } },
    }),
  });
  return faltan;
}
