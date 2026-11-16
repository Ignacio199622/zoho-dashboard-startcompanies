/*
 * QUIÉN ATENDIÓ LA REUNIÓN DE VENTA (6-nov-2026, Ignacio): cuando el lead asistió, Fathom lo asigna.
 *
 * Toda reunión es del usuario robot y el lead queda en Staff, así que el dueño sale de la grabación.
 * Santiago entra a Meet con su nombre. Camila entra con la cuenta "Administración Start Companies":
 * ahí se mira a quién nombran en la charla. Ante la duda no se asigna: un dueño puesto a ojo es peor
 * que uno vacío, porque nadie lo vuelve a revisar.
 *
 * Se escribe sin triggers: no despierta reglas ni mensajes.
 */
import { USUARIOS } from './mapeos.js';
import { esDeSantiago } from './conversaciones/tablero-socios.js';

export const ATIENDEN = {
  'santiago cuellar': { id: '6698625000041418001', nombre: 'Santiago Cuellar' },
  'camila salazar': { id: '6698625000048708001', nombre: 'Camila Salazar' },
};
// Se les puede cambiar el dueño: Staff, Daniel (llama hasta que agenda) y los dos que atienden.
const REASIGNABLES = new Set(['6698625000000502001', '6698625000063175001', ...Object.values(ATIENDEN).map((a) => a.id)]);
const VENTANA_H = 3;
// Fathom graba desde que entra el vendedor: hay grabaciones enteras de él esperando solo. Sin alguien
// de afuera hablando no hubo reunión, y marcarla sería convertir un no-show en asistió.
const MIN_PALABRAS_CLIENTE = 30;

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const EQUIPO = new Set(Object.values(USUARIOS).map((u) => norm(u.nombre)));

export function quienAtendio(reunion) {
  const palabras = {};
  let compartida = false;
  let texto = '';
  let delCliente = 0;
  let nombresDeAfuera = norm(reunion.title);
  for (const l of reunion.transcript || []) {
    const hablante = norm(l.speaker?.display_name);
    if (hablante.startsWith('administracion')) compartida = true;
    texto += ` ${l.text || ''}`;
    const cuantas = String(l.text || '').split(/\s+/).length;
    if (ATIENDEN[hablante]) palabras[hablante] = (palabras[hablante] || 0) + cuantas;
    else if (hablante && !hablante.startsWith('administracion') && !EQUIPO.has(hablante)) {
      delCliente += cuantas;
      nombresDeAfuera += ` ${hablante}`;
    }
  }
  if (delCliente < MIN_PALABRAS_CLIENTE) return null;
  const conNombre = Object.entries(palabras).sort((a, b) => b[1] - a[1])[0];
  if (conNombre) return ATIENDEN[conNombre[0]];
  if (!compartida) return null;
  const dice = (t, n) => new RegExp(`\\b${n}\\b`).test(t);
  // Si el cliente se llama Camila, que la nombren no dice quién atendió.
  if (['camila', 'santiago'].some((n) => dice(nombresDeAfuera, n))) return null;
  // Ignacio usa la misma cuenta y puede nombrar a Camila en su propia llamada.
  if (['ignacio', 'nacho'].some((n) => dice(norm(texto), n))) return null;
  const nombrados = ['camila', 'santiago'].filter((n) => dice(norm(texto), n));
  if (nombrados.length !== 1) return null;
  return nombrados[0] === 'camila' ? ATIENDEN['camila salazar'] : ATIENDEN['santiago cuellar'];
}

/** De las reuniones del lead, la de esa hora. */
export function reunionDeLaLlamada(eventos, fecha) {
  const t = new Date(fecha).getTime();
  return (eventos || [])
    .filter((e) => e.Tipo_de_reuni_n === 'Venta' && !/^\[CANCELADA\]/.test(e.Event_Title || ''))
    .filter((e) => Math.abs(new Date(e.Start_DateTime).getTime() - t) <= VENTANA_H * 3600e3)
    .sort((a, b) => Math.abs(new Date(a.Start_DateTime) - t) - Math.abs(new Date(b.Start_DateTime) - t))[0] || null;
}

/** Deja al que atendió en la reunión y como dueño del lead. Devuelve lo que hizo. zoho: cliente v6. */
export async function asignarAtencion(zoho, { lead, quien, fecha }) {
  const hecho = { dueno: false, reunion: false, motivo: null };
  const ev = await zoho(`Events/search?criteria=${encodeURIComponent(`(What_Id:equals:${lead.id})`)}&fields=id,Event_Title,Start_DateTime,Tipo_de_reuni_n,Por_qui_n_fue_abordado&per_page=50`);
  const evento = reunionDeLaLlamada(ev.data, fecha);
  // Sin reunión de venta no se toca nada: puede ser una llamada de soporte de alguien con un lead viejo.
  if (!evento) {
    hecho.motivo = 'sin reunión de venta a esa hora';
    return hecho;
  }
  if (!evento.Por_qui_n_fue_abordado || evento.Por_qui_n_fue_abordado === 'Sin asignar') {
    const r = await zoho('Events', { method: 'PUT', body: JSON.stringify({ data: [{ id: evento.id, Por_qui_n_fue_abordado: quien.nombre }], trigger: [] }) });
    const r0 = (r.data || [])[0];
    if (r0?.code !== 'SUCCESS') throw new Error(`reunión: ${r0?.code} ${r0?.message}`);
    hecho.reunion = true;
  }
  // Partners y referidos son de Santiago aunque atienda otra persona: queda registrado en la reunión.
  const dueno = esDeSantiago(lead) ? ATIENDEN['santiago cuellar'] : quien;
  if (lead.Owner?.id === dueno.id) return hecho;
  if (!REASIGNABLES.has(lead.Owner?.id)) {
    hecho.motivo = `ya es de ${lead.Owner?.name || lead.Owner?.id}`;
    return hecho;
  }
  const r = await zoho('Leads', { method: 'PUT', body: JSON.stringify({ data: [{ id: lead.id, Owner: { id: dueno.id } }], trigger: [] }) });
  const r0 = (r.data || [])[0];
  if (r0?.code !== 'SUCCESS') throw new Error(`dueño: ${r0?.code} ${r0?.message}`);
  hecho.dueno = true;
  return hecho;
}
