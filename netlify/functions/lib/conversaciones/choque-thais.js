/*
 * DOS REUNIONES DE THAIS EN EL MISMO HORARIO (16-nov-2026).
 *
 * Las reuniones en portugués se reservan en DOS cuentas de Cal (la de ventas
 * startcompanies-businessenusa, con avaliacao-llc-br 7661060 y los -br del 10-nov, y la de
 * Brasil startcompanies). Ninguna veía las reservas de la otra: el 16-nov a las 17:30
 * entraron Marco Dalponte (cuenta Brasil) y Arthur (cuenta ventas) a la vez.
 *
 * El arreglo de fondo está en Cal: todo evento -br revisa conflictos contra el Google
 * Calendar de Thais (suscripto en administracion@). Pero entre que alguien reserva y Thais
 * queda invitada pasan hasta 5 min (invitar-thais.js), así que esto queda de red: si dos
 * reservas en portugués se pisan, avisa una vez por Slack con nombres y horario.
 */
import { env } from './entorno.js';
import { esPortugues } from './invitar-thais.js';
import { clienteDe } from '../cal-cliente.js';

const CUENTAS = () => [['br', env.CALCOM_API_KEY_BR], ['ventas', env.CALCOM_API_KEY]].filter(([, k]) => k);
const V = (k) => ({ Authorization: `Bearer ${k}`, 'cal-api-version': '2024-08-13' });
const VIVA = (b) => !['cancelled', 'rejected'].includes(String(b.status || '').toLowerCase());

/** Devuelve los pares de reservas en portugués que se pisan (próximas, no canceladas). */
export async function unaPasada() {
  const reservas = [];
  for (const [cuenta, k] of CUENTAS()) {
    const res = await fetch('https://api.cal.com/v2/bookings?status=upcoming&take=250', { headers: V(k) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Cal ${cuenta} ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
    for (const b of j.data || []) {
      if (!VIVA(b) || !esPortugues(b)) continue;
      reservas.push({
        cuenta,
        uid: b.uid,
        slug: b.eventType?.slug || '',
        inicio: new Date(b.start).getTime(),
        fin: new Date(b.end).getTime(),
        cliente: clienteDe(b)?.name || clienteDe(b)?.email || '(sin nombre)',
      });
    }
  }
  reservas.sort((a, b) => a.inicio - b.inicio);
  const choques = [];
  for (let i = 0; i < reservas.length; i++) {
    for (let j = i + 1; j < reservas.length && reservas[j].inicio < reservas[i].fin; j++) {
      const [a, b] = [reservas[i], reservas[j]];
      choques.push({ clave: `choque-thais:${[a.uid, b.uid].sort().join('|')}`, a, b });
    }
  }
  return { leidas: reservas.length, choques };
}

const hora = (ms) =>
  new Date(ms).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export const textoChoque = ({ a, b }) =>
  `:rotating_light: <@U0CAMCXF01K> *Dos reuniones en portugués en el mismo horario* (${hora(a.inicio)} AR): ` +
  `*${a.cliente}* (${a.slug}, cuenta ${a.cuenta}) y *${b.cliente}* (${b.slug}, cuenta ${b.cuenta}). ` +
  `Reprogramar una o que la tome Daniel.`;
