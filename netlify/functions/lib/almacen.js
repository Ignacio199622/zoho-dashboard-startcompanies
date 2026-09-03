// Donde guarda el agente lo que necesita recordar entre corridas.
//
// En la maquina: archivos en salidas/.
// En Netlify: Netlify Blobs, porque el disco de una funcion no sobrevive a la
// corrida siguiente.
//
// El resto del codigo no se entera de cual de los dos esta usando.
//
// EXCEPCION, y es importante: el Coach de Ventas puede publicar tarjetas desde
// la maquina, pero los botones de esas tarjetas los atiende la funcion de
// Netlify, que busca el caso en Blobs. Si el caso quedo en un archivo local, el
// boton no encuentra nada y la tarjeta queda muerta. Por eso existe
// `usarAlmacenDeProduccion()`: hace que el CLI escriba en el mismo lugar que
// lee produccion.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EN_NETLIFY = Boolean(process.env.NETLIFY || process.env.NETLIFY_DEV || process.env.AWS_LAMBDA_FUNCTION_NAME);
const SITIO = '3f7d9d00-3f7f-47ec-9d83-9fd75259d5ad'; // metricastart

let forzado = false;
const usaBlobs = () => EN_NETLIFY || forzado;

let store = null;
async function blobs() {
  if (store) return store;
  const { getStore } = await import('@netlify/blobs');
  const opciones = { name: 'agente-llamadas', consistency: 'strong' };
  // Dentro de Netlify el contexto viene solo; desde afuera hay que decirle a
  // que sitio y con que token.
  if (!EN_NETLIFY) {
    opciones.siteID = process.env.NETLIFY_SITE_ID || SITIO;
    opciones.token = process.env.NETLIFY_AUTH_TOKEN;
  }
  store = getStore(opciones);
  return store;
}

/**
 * Escribir y leer del almacen de produccion aunque estemos en la maquina.
 * Devuelve false si falta el token, sin romper nada: quien llama decide si
 * sigue en local o si aborta.
 */
export function usarAlmacenDeProduccion() {
  if (!process.env.NETLIFY_AUTH_TOKEN) return false;
  forzado = true;
  store = null;
  return true;
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'salidas');
const ruta = (clave) => join(DIR, `${clave}.json`);

export async function leer(clave, porDefecto = null) {
  if (usaBlobs()) {
    try {
      const s = await blobs();
      const v = await s.get(clave, { type: 'json' });
      return v ?? porDefecto;
    } catch {
      return porDefecto;
    }
  }
  try {
    if (!existsSync(ruta(clave))) return porDefecto;
    return JSON.parse(readFileSync(ruta(clave), 'utf8'));
  } catch {
    return porDefecto;
  }
}

export async function guardar(clave, valor) {
  if (usaBlobs()) {
    const s = await blobs();
    await s.setJSON(clave, valor);
    return;
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ruta(clave), JSON.stringify(valor, null, 1), 'utf8');
}

export const enNetlify = () => EN_NETLIFY;
export const almacenCompartido = () => usaBlobs();
