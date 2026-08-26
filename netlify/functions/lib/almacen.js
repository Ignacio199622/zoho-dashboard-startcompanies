// Donde guarda el agente lo que necesita recordar entre corridas.
//
// En la maquina: archivos en salidas/.
// En Netlify: Netlify Blobs, porque el disco de una funcion no sobrevive a la
// corrida siguiente.
//
// El resto del codigo no se entera de cual de los dos esta usando.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EN_NETLIFY = Boolean(process.env.NETLIFY || process.env.NETLIFY_DEV || process.env.AWS_LAMBDA_FUNCTION_NAME);

let store = null;
async function blobs() {
  if (store) return store;
  const { getStore } = await import('@netlify/blobs');
  // consistency:'strong' para que dos corridas seguidas no se pisen.
  store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
  return store;
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'salidas');
const ruta = (clave) => join(DIR, `${clave}.json`);

export async function leer(clave, porDefecto = null) {
  if (EN_NETLIFY) {
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
  if (EN_NETLIFY) {
    const s = await blobs();
    await s.setJSON(clave, valor);
    return;
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ruta(clave), JSON.stringify(valor, null, 1), 'utf8');
}

export const enNetlify = () => EN_NETLIFY;
