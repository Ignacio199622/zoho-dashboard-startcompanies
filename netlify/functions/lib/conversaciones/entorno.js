// Lee el .env de la raiz del agente. La key de Gemini, si no esta ahi, sale de
// la configuracion de los MCP (ver gemini.js), igual que en el agente de llamadas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

function cargar() {
  let txt = '';
  try {
    txt = readFileSync(join(RAIZ, '.env'), 'utf8');
  } catch {
    return {};
  }
  return Object.fromEntries(
    txt
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
      .filter(([, v]) => v !== '')
  );
}

export const env = { ...cargar(), ...process.env };
