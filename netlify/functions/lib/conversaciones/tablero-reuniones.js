/*
 * TABLEROS DE REUNIONES (6-nov-2026, Ignacio): las reuniones de venta en español van al tablero de
 * Camila y Santiago (Etapa_Ventas) y las de portugués al de Thais (Etapa_Thais).
 *
 * Se lee la reunión, no Lead_Status: hay leads en "Reunión Agendada" desde septiembre sin reunión viva.
 * Calificar solo vale si asistió. En español el que no asistió queda en la columna No asistió, compartida
 * entre Camila y Santiago, sin dueño asignado. En portugués sale del tablero. Brasil y Argentina además
 * vuelven a Daniel (Reintentando asistencia, ver tablero-daniel.js). Sin dependencias.
 */
import { USUARIOS } from '../mapeos.js';
import { esDeSantiago } from './tablero-socios.js';

const DOS_HORAS = 2 * 3600 * 1000;

export const TABLEROS = {
  ventas: {
    campo: 'Etapa_Ventas',
    agendado: 'Agendado',
    sinMarcar: 'Sin marcar',
    asistio: 'Asistió',
    noAsistio: 'No asistió',
    sinInteres: 'No calificado',
    finales: new Set(),
  },
  thais: {
    campo: 'Etapa_Thais',
    agendado: 'Reunião agendada',
    sinMarcar: 'Sem marcar',
    asistio: 'Reunião feita',
    noAsistio: null,
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

// "Sin asignar" es lo que pone el sistema al marcar un no-show solo: no dice que alguien atendió.
const conVendedor = (r) => Boolean(r.Por_qui_n_fue_abordado) && r.Por_qui_n_fue_abordado !== 'Sin asignar';

/** Etapa que le corresponde. null = fuera del tablero. */
function etapaDe(t, actual, { ultima, asistio, ahora }) {
  if (actual && t.finales.has(actual)) return actual;
  const previa = !actual || actual === t.agendado || actual === t.sinMarcar || actual === t.noAsistio;
  const avanzada = !previa && actual !== t.asistio;
  if (avanzada && asistio) return actual;

  if (!ultima) return asistio ? (actual || null) : null;
  const estado = ultima.Status_del_Meet || '';
  const siguio = previa ? t.asistio : actual;
  // Fathom cargó quién atendió: hubo reunión, aunque nadie la haya marcado.
  if (estado === 'Asistió' || (!estado && conVendedor(ultima))) return siguio;
  if (estado === 'Asistió sin interes') return t.sinInteres;
  if (estado === 'No asistió' || estado === 'Reagendar') return asistio ? siguio : t.noAsistio;
  // Una reunión nueva y sin marcar manda sobre un "Asistió" o "No asistió" anterior.
  if (new Date(ultima.Start_DateTime).getTime() > ahora - DOS_HORAS) return t.agendado;
  return asistio ? siguio : t.sinMarcar;
}

/** Qué escribirle al lead. null = nada. reuniones: las vivas de ese lead. */
export function cambioDeReunion(l, reuniones = [], ahora = Date.now()) {
  const ultima = reuniones[reuniones.length - 1] || null;
  const pt = esPortugues(l, ultima);
  const t = pt ? TABLEROS.thais : TABLEROS.ventas;
  const actual = l[t.campo] || null;
  // El vendedor solo prueba asistencia si nadie marcó la reunión: ahora también se elige en No asistió.
  const asistio = reuniones.some((r) => r.Status_del_Meet === 'Asistió' || (!r.Status_del_Meet && conVendedor(r)))
    // La reunión ya salió de la ventana que se consulta: queda lo que dejó escrito el blueprint.
    || (!reuniones.length && String(l.Asistio_al_Meeting || '').trim() === 'Si')
    // El agente de Fathom pasa el lead a Thais sin marcar la reunión: eso cuenta como que asistió.
    || (pt && l.Owner?.id === '6698625000063172001');
  const etapa = etapaDe(t, actual, { ultima, asistio, ahora });
  return etapa === actual ? null : { [t.campo]: etapa };
}

// El vendedor que eligieron al apretar Asistió (o el que cargó Fathom) pasa a ser el dueño del lead.
// Partners y referidos son de Santiago, portugués queda con Thais y un dueño que no sea Staff, Daniel,
// Santiago o Camila no se pisa. Un nombre sin usuario conocido no cambia nada.
const REASIGNABLES = new Set(['6698625000000502001', '6698625000063175001', '6698625000041418001', '6698625000048708001']);
const NOMBRES = { 'Daniel Dos Santos': '6698625000063175001', 'Adrián Calabró': '6698625000050962001' };
const usuarioPorNombre = (nombre) => NOMBRES[nombre] || Object.entries(USUARIOS).find(([, u]) => u.nombre === nombre)?.[0] || null;

export function cambioDeDueno(l, reuniones = []) {
  const ultima = reuniones[reuniones.length - 1];
  if (!ultima || !conVendedor(ultima) || esPortugues(l, ultima) || !REASIGNABLES.has(l.Owner?.id)) return null;
  if (!['', 'Asistió', 'Asistió sin interes', 'No asistió'].includes(ultima.Status_del_Meet || '')) return null;
  const id = esDeSantiago(l) ? '6698625000041418001' : usuarioPorNombre(ultima.Por_qui_n_fue_abordado);
  return id && id !== l.Owner?.id ? { Owner: { id } } : null;
}

export const CAMPOS_REUNION = 'Full_Name,Owner,Idioma,Mobile,Phone,Country,Tipo,Tag,Landing_Origen,Lead_Source,Lead_Status,Asistio_al_Meeting,Etapa_Ventas,Etapa_Thais';
export const CAMPOS_EVENTO = 'Start_DateTime,Status_del_Meet,What_Id,Event_Title,Idioma,Por_qui_n_fue_abordado';

/** Los que ya están en un tablero y pueden tener que moverse. */
export const CRITERIO_EN_TABLERO = [
  ...['Agendado', 'Sin marcar', 'No asistió', 'Asistió', 'Calificado', 'No calificado'].map((v) => `(Etapa_Ventas:equals:${v})`),
  ...['Reunião agendada', 'Sem marcar', 'Qualificado'].map((v) => `(Etapa_Thais:equals:${v})`),
].join('or');

/** leads: los del tablero más los de las reuniones. Devuelve [{ l, c }] con lo que hay que escribir. */
export function planReuniones(leads, reuniones, ahora = Date.now()) {
  const porLead = reunionesPorLead(reuniones);
  return leads
    .map((l) => {
      const c = { ...cambioDeReunion(l, porLead.get(l.id) || [], ahora), ...cambioDeDueno(l, porLead.get(l.id) || []) };
      return { l, c: Object.keys(c).length ? c : null };
    })
    .filter((x) => x.c);
}
