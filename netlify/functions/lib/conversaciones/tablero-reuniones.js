/*
 * TABLEROS DE REUNIONES (6-nov-2026, Ignacio): las reuniones de venta en español van al tablero de
 * Camila y Santiago (Etapa_Ventas) y las de portugués al de Thais (Etapa_Thais).
 *
 * Se lee la reunión, no Lead_Status: hay leads en "Reunión Agendada" desde septiembre sin reunión viva.
 * Calificar solo vale si asistió. Si no asistió, el lead sale del tablero y Daniel lo retoma con su
 * propia etapa (Reintentando asistencia, ver tablero-daniel.js). Sin dependencias.
 */
const DOS_HORAS = 2 * 3600 * 1000;

export const TABLEROS = {
  ventas: {
    campo: 'Etapa_Ventas',
    agendado: 'Agendado',
    sinMarcar: 'Sin marcar',
    asistio: 'Asistió',
    sinInteres: 'No calificado',
    finales: new Set(),
  },
  thais: {
    campo: 'Etapa_Thais',
    agendado: 'Reunião agendada',
    sinMarcar: 'Sem marcar',
    asistio: 'Reunião feita',
    sinInteres: 'Perdido',
    finales: new Set(['Perdido']),
  },
};

const esPortugues = (l, reunion) => {
  const tel = String(l.Mobile || l.Phone || '').replace(/[\s()-]/g, '');
  return reunion?.Idioma === 'Português' || l.Idioma === 'Português' || tel.startsWith('+55');
};

/** Reuniones vivas de cada lead, de la más vieja a la más nueva. */
export function reunionesPorLead(reuniones) {
  const m = new Map();
  for (const r of reuniones) {
    const id = r.What_Id?.id;
    if (!id || /^\[CANCELADA\]/.test(r.Event_Title || '') || r.Status_del_Meet === 'Cancelada') continue;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(r);
  }
  for (const lista of m.values()) lista.sort((a, b) => new Date(a.Start_DateTime) - new Date(b.Start_DateTime));
  return m;
}

/** Etapa que le corresponde. null = fuera del tablero. */
function etapaDe(t, actual, { ultima, asistio, ahora }) {
  if (actual && t.finales.has(actual)) return actual;
  const previa = !actual || actual === t.agendado || actual === t.sinMarcar;
  const avanzada = !previa && actual !== t.asistio;
  if (avanzada && asistio) return actual;

  if (!ultima) return asistio ? (actual || null) : null;
  const estado = ultima.Status_del_Meet || '';
  if (estado === 'Asistió') return previa ? t.asistio : actual;
  if (estado === 'Asistió sin interes') return t.sinInteres;
  const inicio = new Date(ultima.Start_DateTime).getTime();
  const viva = inicio > ahora - DOS_HORAS;
  // Una reunión nueva manda sobre un "Asistió" o "No asistió" anterior.
  if (viva) return t.agendado;
  if (estado === 'No asistió' || estado === 'Reagendar') return asistio ? (actual || t.asistio) : null;
  return asistio ? (actual || t.asistio) : t.sinMarcar;
}

/** Qué escribirle al lead. null = nada. reuniones: las vivas de ese lead. */
export function cambioDeReunion(l, reuniones = [], ahora = Date.now()) {
  const ultima = reuniones[reuniones.length - 1] || null;
  const pt = esPortugues(l, ultima);
  const t = pt ? TABLEROS.thais : TABLEROS.ventas;
  const actual = l[t.campo] || null;
  const asistio = reuniones.some((r) => r.Status_del_Meet === 'Asistió')
    // La reunión ya salió de la ventana que se consulta: queda lo que dejó escrito el blueprint.
    || (!reuniones.length && String(l.Asistio_al_Meeting || '').trim() === 'Si')
    // El agente de Fathom pasa el lead a Thais sin marcar la reunión: eso cuenta como que asistió.
    || (pt && l.Owner?.id === '6698625000063172001');
  const etapa = etapaDe(t, actual, { ultima, asistio, ahora });
  return etapa === actual ? null : { [t.campo]: etapa };
}

export const CAMPOS_REUNION = 'Full_Name,Owner,Idioma,Mobile,Phone,Asistio_al_Meeting,Etapa_Ventas,Etapa_Thais';
export const CAMPOS_EVENTO = 'Start_DateTime,Status_del_Meet,What_Id,Event_Title,Idioma';

/** Los que ya están en un tablero y pueden tener que moverse. */
export const CRITERIO_EN_TABLERO = [
  ...['Agendado', 'Sin marcar', 'Asistió', 'Calificado', 'No calificado'].map((v) => `(Etapa_Ventas:equals:${v})`),
  ...['Reunião agendada', 'Sem marcar', 'Qualificado'].map((v) => `(Etapa_Thais:equals:${v})`),
].join('or');

/** leads: los del tablero más los de las reuniones. Devuelve [{ l, c }] con lo que hay que escribir. */
export function planReuniones(leads, reuniones, ahora = Date.now()) {
  const porLead = reunionesPorLead(reuniones);
  return leads
    .map((l) => ({ l, c: cambioDeReunion(l, porLead.get(l.id) || [], ahora) }))
    .filter((x) => x.c);
}
