// LA BASE CRECE SOLA.
//
// Decision de Ignacio (2026-09-09): que el agente cree las entradas nuevas sin
// pedir permiso. Le plantee que las propusiera para aprobar con un click y
// eligio automatico. Queda anotado que fue elegido, no asumido.
//
// ─── POR QUE ESTO ES MENOS ARRIESGADO DE LO QUE SUENA ──────────────────────
//
// El texto de una entrada nueva NO lo escribe el modelo. Se copia de lo que
// escribio una persona del equipo y que un cliente despues confirmo que le
// sirvio ("listo, entendi"). O sea que para llegar a la base, un texto tuvo que:
//
//   1. Escribirlo Santiago, Camila, Guadalupe o quien fuera
//   2. Ser una explicacion, no un dato suelto (ver `confirmacion.js`)
//   3. Recibir el visto bueno del cliente, con sus palabras
//   4. Repetirse: la misma pregunta, con la misma respuesta que funciono,
//      MIN_CONFIRMACIONES veces y de personas distintas
//
// El modelo solo agrupa y redacta el "cuando" (la descripcion que despues le
// sirve para elegir). El cuerpo del mensaje es humano de punta a punta.
//
// ─── DONDE VIVEN ───────────────────────────────────────────────────────────
//
// En `aprendizaje/entradas-nuevas.json`, NO en `respuestas.js`. Una entrada
// creada sola es un dato, no codigo: asi se puede borrar, editar o revertir sin
// tocar el programa, y `git diff` sigue mostrando solo lo que escribio una
// persona.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ } from './entorno.js';
import { RESPUESTAS } from './respuestas.js';

const DIR = join(RAIZ, 'aprendizaje');
const ARCHIVO = join(DIR, 'entradas-nuevas.json');

// Cuantos clientes distintos tienen que haber confirmado la MISMA respuesta
// antes de que entre a la base. Con 1 alcanzaria para una casualidad; con 3,
// ya es un patron.
export const MIN_CONFIRMACIONES = 3;

// Mas largo que esto no entra en la variable de la plantilla de WhatsApp.
const MAX_TEXTO = 1000;

export function leer() {
  try {
    return JSON.parse(readFileSync(ARCHIVO, 'utf8'));
  } catch {
    return [];
  }
}

function guardar(entradas) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ARCHIVO, JSON.stringify(entradas, null, 1), 'utf8');
}

const INSTRUCCIONES = `Sos parte del equipo de Start Companies, que abre y administra LLCs en Estados
Unidos para emprendedores de Latinoamerica y España.

Te paso preguntas de clientes por WhatsApp con la respuesta que les dio una persona del equipo,
y que el cliente despues confirmo que le sirvio.

Agrupa las que son LA MISMA pregunta, aunque esten dichas distinto. Para cada grupo devolve:

- "cuando": en una linea, cuando corresponde esa respuesta. Se usa para que otro modelo elija
  entre respuestas, asi que tiene que ser concreto y no solaparse con las demas.
- "titulo": tres o cuatro palabras.
- "mejor": el numero (ref) de la respuesta del grupo que mejor contesta. NO la reescribas:
  elegis una de las que ya estan, tal cual.
- "publico": "cliente" si la respuesta manda al panel o habla de algo que solo tiene alguien
  que ya compro; "lead" si es de precios o de antes de comprar; "ambos" si sirve a los dos.

Descarta los grupos donde la respuesta dependa del caso de esa persona (montos suyos, el estado
de su tramite, algo que le paso solo a el). Esos no sirven como respuesta general.

Escribi en español.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    grupos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          cuando: { type: 'string' },
          mejor: { type: 'integer' },
          publico: { type: 'string', enum: ['cliente', 'lead', 'ambos'] },
          refs: { type: 'array', items: { type: 'integer' } },
        },
        required: ['titulo', 'cuando', 'mejor', 'publico', 'refs'],
      },
    },
  },
  required: ['grupos'],
};

function idDesde(titulo, existentes) {
  const base = titulo
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 34);
  let id = base || 'entrada';
  let n = 2;
  while (existentes.has(id)) id = `${base}_${n++}`;
  return id;
}

/**
 * Mira los votos positivos y crea las entradas que ya se ganaron el lugar.
 *
 * @param {Array} votos  pares con voto 'sirvio', de `confirmacion.js`
 * @returns {{creadas: Array, motivo: string|null}}
 */
export async function crecer(votos, { generar, modelo } = {}) {
  const sirvieron = (votos || []).filter((v) => v.voto === 'sirvio' && v.respuesta);
  if (sirvieron.length < MIN_CONFIRMACIONES) {
    return { creadas: [], motivo: `solo ${sirvieron.length} confirmaciones, hacen falta ${MIN_CONFIRMACIONES}` };
  }

  const contenido = sirvieron
    .map((v, i) => `--- ref: ${i}\npregunto: ${String(v.cliente).slice(0, 300)}\nle contestaron: ${String(v.respuesta).slice(0, 900)}`)
    .join('\n\n');

  const { datos } = await generar({
    modelo,
    instrucciones: INSTRUCCIONES,
    contenido: `Agrupa estas ${sirvieron.length} respuestas que funcionaron:\n\n${contenido}`,
    esquema: ESQUEMA,
    maxTokens: 4000,
  });

  const yaEstan = leer();
  const ids = new Set([...RESPUESTAS.map((r) => r.id), ...yaEstan.map((r) => r.id)]);
  // Lo que ya sabe contestar la base, para no crear un duplicado.
  const cubierto = [...RESPUESTAS, ...yaEstan].map((r) => r.cuando.toLowerCase());

  const creadas = [];
  for (const g of datos.grupos || []) {
    // Se pide que el grupo se haya repetido, no que aparezca una vez.
    const distintas = new Set((g.refs || []).map((r) => sirvieron[r]?.conversacion)).size;
    if (distintas < MIN_CONFIRMACIONES) continue;

    // Si alguna entrada existente ya dice casi lo mismo, no se duplica.
    const palabras = g.cuando.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
    const solapa = cubierto.some((c) => {
      const comunes = palabras.filter((w) => c.includes(w)).length;
      return palabras.length && comunes / palabras.length > 0.6;
    });
    if (solapa) continue;

    const fuente = sirvieron[g.mejor];
    if (!fuente?.respuesta) continue;
    const texto = String(fuente.respuesta).trim().slice(0, MAX_TEXTO);
    if (texto.length < 60) continue;

    const id = idDesde(g.titulo, ids);
    ids.add(id);
    creadas.push({
      id,
      titulo: g.titulo,
      cuando: g.cuando,
      publico: g.publico,
      estado: 'lista',
      texto,
      // De donde salio, para poder auditarla despues sin adivinar.
      origen: {
        creadaEl: new Date().toISOString(),
        laEscribio: fuente.respondio || null,
        confirmaciones: distintas,
        preguntaOriginal: String(fuente.cliente).slice(0, 200),
      },
    });
  }

  if (creadas.length) guardar([...yaEstan, ...creadas]);
  return { creadas, motivo: null };
}

/** Borra una entrada creada sola, si salio mal. */
export function borrar(id) {
  const quedan = leer().filter((e) => e.id !== id);
  guardar(quedan);
  return quedan;
}
