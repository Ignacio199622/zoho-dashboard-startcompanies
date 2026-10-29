// Hora del cliente, no hora de Argentina.
// El campo Pa_s del CRM esta vacio en todos los leads, asi que la zona horaria
// se deriva del prefijo del telefono. Es una aproximacion: paises con varias
// zonas (MX, BR, US) quedan en la de su capital y se marcan como "aprox".
import { TZ_POR_PREFIJO } from './config.js';

const PREFIJOS = Object.keys(TZ_POR_PREFIJO).sort((a, b) => b.length - a.length);

// Paises con mas de un huso: la tz elegida puede errar por 1-3 horas.
const MULTIZONA = new Set(['52', '55', '1']);

export function zonaDeTelefono(telefono) {
  if (!telefono) return { tz: null, prefijo: null, aprox: true };
  const limpio = String(telefono).replace(/[^\d+]/g, '').replace(/^\+/, '');
  for (const p of PREFIJOS) {
    if (limpio.startsWith(p)) {
      return { tz: TZ_POR_PREFIJO[p], prefijo: `+${p}`, aprox: MULTIZONA.has(p) };
    }
  }
  return { tz: null, prefijo: null, aprox: true };
}

/** Hora (0-23) que marca el reloj del cliente en ese instante. */
export function horaLocal(fecha, tz) {
  if (!tz) return null;
  const h = new Intl.DateTimeFormat('es-AR', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).format(fecha);
  return Number(h);
}

export function formatearEn(fecha, tz) {
  if (!tz) return null;
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha);
}
