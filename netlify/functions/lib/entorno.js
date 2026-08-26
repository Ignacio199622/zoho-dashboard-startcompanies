// Las credenciales salen de dos lugares distintos segun donde corra el agente:
// en la maquina, del archivo .env; en Netlify, de las variables del sitio.
// Este modulo resuelve las dos sin que el resto del codigo se entere.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function delArchivo() {
  // En Netlify no hay .env: todo viene por variables del sitio. Esto queda
  // por si alguien corre estas funciones localmente.
  try {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
    const ruta = join(raiz, '.env');
    if (!existsSync(ruta)) return {};
    return Object.fromEntries(
      readFileSync(ruta, 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

// process.env gana: en Netlify es la unica fuente, y en local permite pisar un
// valor sin editar el archivo.
export const env = { ...delArchivo(), ...process.env };

/** Falla temprano y claro si falta una credencial, en vez de dar un 401 raro. */
export function exigir(...claves) {
  const faltan = claves.filter((k) => !env[k]);
  if (faltan.length) {
    throw new Error(`Faltan credenciales: ${faltan.join(', ')}`);
  }
}
