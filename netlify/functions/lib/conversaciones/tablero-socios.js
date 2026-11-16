/*
 * FLUJO Y RESPONSABLE (6-nov-2026, Ignacio): partners y referidos son siempre de Santiago, y todo lead
 * lleva su flujo a la vista. Portugués queda afuera: es de Daniel y después de Thais.
 *
 * Al tablero de Santiago entran los que están en movimiento y los recién llegados, no los 170 que
 * siguen en Retargeting: esos pasan a su nombre, siguen su cadencia y no le tapan lo urgente.
 * Sin dependencias: lo usan la pasada de cada 5 minutos y la carga inicial.
 */
import { flujoDe, paisDe } from './tablero-daniel.js';

export const SANTIAGO_ID = '6698625000041418001';
const STAFF_ID = '6698625000000502001';
const INACTIVOS = new Set(['Nurturing', 'Fuera de flujo', 'No Calificado', 'No Interesado', 'Convertido', 'Cierrado ganado', 'Cerrado perdido', 'Lost Lead', 'Not Qualified', 'Junk Lead', 'Prueba']);
const EN_MOVIMIENTO = { 'Reunión Agendada': 'Reunión agendada', Comercial: 'Contactado', 'En Calificación': 'Asistió', 'No Show': 'Por contactar' };
const RECIEN_LLEGADO_MS = 48 * 3600 * 1000;

export const esDeSantiago = (l) => ['Socio', 'Referido'].includes(flujoDe(l)) && paisDe(l) !== 'Brasil';

/** Qué escribirle al lead. null = nada. */
export function cambioDeFlujo(l, ahora = Date.now()) {
  const c = {};
  const flujo = flujoDe(l);
  if (l.Flujo_Daniel !== flujo) c.Flujo_Daniel = flujo;
  if (!esDeSantiago(l) || INACTIVOS.has(l.Lead_Status)) return Object.keys(c).length ? c : null;

  if (l.Owner?.id === STAFF_ID) c.Owner = { id: SANTIAGO_ID };
  const e = l.Etapa_Socios || null;
  const reciente = ahora - new Date(l.Created_Time).getTime() < RECIEN_LLEGADO_MS;
  if (!e && (EN_MOVIMIENTO[l.Lead_Status] || reciente)) c.Etapa_Socios = EN_MOVIMIENTO[l.Lead_Status] || 'Por contactar';
  // Lo automático: agendó, y lo que pasó con esa reunión. El resto lo mueve él.
  else if (e === 'Por contactar' || e === 'Contactado') {
    if (l.Lead_Status === 'Reunión Agendada') c.Etapa_Socios = 'Reunión agendada';
  } else if (e === 'Reunión agendada') {
    if (l.Lead_Status === 'No Show') c.Etapa_Socios = 'Por contactar';
    else if (l.Lead_Status === 'En Calificación') c.Etapa_Socios = 'Asistió';
  }
  return Object.keys(c).length ? c : null;
}

export const CAMPOS_FLUJO = 'Full_Name,Owner,Lead_Status,Tipo,Tag,Landing_Origen,Lead_Source,Idioma,Mobile,Phone,Country,Created_Time,Flujo_Daniel,Etapa_Socios';
