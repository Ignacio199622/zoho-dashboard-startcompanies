/*
 * Cuenta las reservas ACTIVAS (proximas, no canceladas) de una persona en Cal,
 * sumando TODOS los calendarios, por mail o por los ultimos 8 digitos del
 * telefono (asi el 9 argentino y el 1 mexicano no la esquivan).
 *
 * POR QUE EXISTE (24-sep-2026)
 * La guardia de reservas del Flow "Cal" (convertCal, seccion 2b) cancela la
 * reserva que pasa el tope de 3. Para contar necesita leer Cal, y la conexion
 * cal_form_meta de Zoho Flow no autentica contra la API v2 (el GET da
 * "PermissionsGuard - no authentication provided"). En vez de escribir la
 * clave en el codigo del Flow, el Flow le pregunta a esta funcion, que usa
 * CALCOM_API_KEY de las variables del sitio.
 *
 * GET /.netlify/functions/cal-tope?email=...&tel=...&uid=<reserva nueva>
 * -> { activas: n }   (n excluye la reserva `uid` y los calendarios de soporte)
 * Solo devuelve un numero: no expone datos de nadie.
 */
import { env } from './lib/entorno.js';
import { clienteDe } from './lib/cal-cliente.js';

// Calendarios de soporte: el cliente agenda lo que quiera, no cuentan para el tope.
const SOPORTE = new Set(['agenda-consulta-clientes']);
const cola = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : ''; };

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const email = (q.get('email') || '').trim().toLowerCase();
  const tel = cola(q.get('tel'));
  const uid = q.get('uid') || '';
  if (!email && !tel) return Response.json({ error: 'falta email o tel' }, { status: 400 });
  if (!env.CALCOM_API_KEY) return Response.json({ error: 'falta CALCOM_API_KEY' }, { status: 500 });
  const r = await fetch('https://api.cal.com/v2/bookings?status=upcoming&take=250', {
    headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, 'cal-api-version': '2024-08-13' },
  });
  if (!r.ok) return Response.json({ error: 'cal ' + r.status }, { status: 502 });
  const lista = (await r.json()).data || [];
  let activas = 0;
  for (const b of lista) {
    if (b.uid === uid || b.status === 'cancelled' || b.status === 'rejected') continue;
    if (SOPORTE.has(b.eventType?.slug)) continue;
    const a = clienteDe(b) || {};
    if ((email && (a.email || '').toLowerCase() === email) || (tel && cola(a.phoneNumber) === tel)) activas++;
  }
  return Response.json({ activas, leidas: lista.length });
};

export const config = { path: '/.netlify/functions/cal-tope' };
