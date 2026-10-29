/*
 * THAIS EN LAS REUNIONES DE BRASIL (29-oct-2026, Ignacio: "solo que thais vea las reuniones en portugues!").
 *
 * Hasta hoy la sumaban a mano en Google, una por una. Esto la agrega como invitada en Cal
 * (Cal actualiza el evento de Google y le llega la invitación con el Meet) a toda reserva
 * futura de un calendario en portugués: slug que termina en -br o avaliacao-llc-br (también
 * el 7661060 viejo de la cuenta de ventas, que todavía tiene reservas vivas). Las de español
 * y las de soporte en otro idioma no se tocan.
 */
import { env } from './entorno.js';

export const THAIS = { email: 'thais@startcompanies.net', name: 'Thais Monteiro' };
const CUENTAS = () => [['br', env.CALCOM_API_KEY_BR], ['ventas', env.CALCOM_API_KEY]].filter(([, k]) => k);
const V = (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'cal-api-version': '2024-08-13' });

export const esPortugues = (b) => /(-br|^avaliacao-llc-br)$/.test(b.eventType?.slug || '');
const yaEsta = (b) =>
  [...(b.attendees || []).map((a) => a.email), ...(b.guests || [])].some((m) => String(m).toLowerCase() === THAIS.email);

/** escribir=false: solo dice a cuáles la sumaría. */
export async function unaPasada({ escribir = false, solo = null } = {}) {
  const r = { invitadas: [], fallidas: [] };
  for (const [cuenta, k] of CUENTAS()) {
    const res = await fetch('https://api.cal.com/v2/bookings?status=upcoming&take=100', { headers: V(k) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Cal ${cuenta} ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
    for (const b of j.data || []) {
      if (!esPortugues(b) || yaEsta(b) || (solo && b.uid !== solo)) continue;
      const fila = { cuenta, uid: b.uid, titulo: b.title, inicio: b.start };
      if (!escribir) { r.invitadas.push(fila); continue; }
      const g = await fetch(`https://api.cal.com/v2/bookings/${b.uid}/guests`, {
        method: 'POST',
        headers: V(k),
        body: JSON.stringify({ guests: [THAIS] }),
      });
      const gj = await g.json().catch(() => ({}));
      if (g.ok) r.invitadas.push(fila);
      else r.fallidas.push({ ...fila, error: `${g.status} ${JSON.stringify(gj.error || gj).slice(0, 160)}` });
    }
  }
  return r;
}
