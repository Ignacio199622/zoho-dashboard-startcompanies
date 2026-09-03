// Los casos que esperan que un vendedor toque un boton.
//
// El boton de Slack solo puede llevar 2000 caracteres en su `value`, y el caso
// entero (informe + mensaje + lead) es mucho mas. Asi que el boton lleva un id
// y el caso vive aca, en el mismo almacen que el resto del agente: archivos en
// la maquina, Netlify Blobs en produccion.
import { leer, guardar } from './almacen.js';

const CLAVE = 'coach-casos';
const DIAS_QUE_SE_GUARDAN = 14;

const nuevoId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export async function todos() {
  return (await leer(CLAVE, {})) || {};
}

export async function obtener(id) {
  return (await todos())[id] || null;
}

/** Guarda un caso nuevo y devuelve su id. */
export async function crear(caso) {
  const t = await todos();
  const id = nuevoId();
  t[id] = { ...caso, id, creado: new Date().toISOString(), estado: 'pendiente' };
  await guardar(CLAVE, podar(t));
  return t[id];
}

/** Actualiza un caso existente (estado, ts de Slack, texto editado). */
export async function actualizar(id, cambios) {
  const t = await todos();
  if (!t[id]) throw new Error(`no existe el caso ${id}`);
  t[id] = { ...t[id], ...cambios };
  await guardar(CLAVE, t);
  return t[id];
}

/**
 * Los casos viejos se van solos. Sin esto el blob crece para siempre y la
 * funcion de Netlify tarda cada vez mas en arrancar.
 */
function podar(t) {
  const corte = Date.now() - DIAS_QUE_SE_GUARDAN * 24 * 3600e3;
  return Object.fromEntries(Object.entries(t).filter(([, c]) => new Date(c.creado || 0).getTime() >= corte));
}
