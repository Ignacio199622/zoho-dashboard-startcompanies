/*
 * TABLERO DE DANIEL (5-nov-2026, Ignacio): llama hasta que el lead agende, y ahí termina su parte.
 * Entran sus leads en portugués y los argentinos activos creados desde octubre, incluidos los que
 * vienen del panel. País y Flujo van en campos propios para que distinga cada tarjeta.
 * Sin dependencias: lo usan la función de cada 5 minutos y la carga inicial.
 */
export const THAIS_ID = '6698625000063172001';
export const DANIEL_ID = '6698625000063175001';
export const DESDE_ARGENTINA = '2026-10-01';

// Un lead argentino en Nurturing o ya cerrado no entra: Daniel llama a los que siguen activos.
const ACTIVOS = new Set(['Captación', 'Agendamiento', 'Retargeting', 'Comercial', 'Retargeting Lili', 'No Show', 'Nuevo MQL', 'Reunión Agendada']);
// En estos estados el lead ya no recibe secuencia: "Perdido" no tiene nada que frenar.
const SIN_SECUENCIA = new Set(['Fuera de flujo', 'No Interesado', 'No Calificado', 'Reunión Agendada', 'Convertido']);

// Hay teléfonos cargados sin el + ("54 9 3415 95-5558"). Con menos de 11 dígitos no se asume país.
const telefono = (l) => {
  const t = String(l.Mobile || l.Phone || '').replace(/[\s()-]/g, '');
  return !t.startsWith('+') && t.replace(/\D/g, '').length >= 11 ? `+${t.replace(/\D/g, '')}` : t;
};
const etiquetas = (l) => (l.Tag || []).map((t) => t.name);

export function paisDe(l) {
  if (l.Idioma === 'Português' || telefono(l).startsWith('+55')) return 'Brasil';
  if (telefono(l).startsWith('+54') || l.Country === 'Argentina') return 'Argentina';
  return null;
}

export function flujoDe(l) {
  const t = etiquetas(l);
  if (/referid/i.test(l.Lead_Source || '') || t.some((x) => /^referid/i.test(x))) return 'Referido';
  if (l.Tipo === 'Posible Partner' || t.includes('Form Socios Meta') || t.includes('Partner Web')) return 'Socio';
  if (/plataforma/i.test(l.Landing_Origen || '') || t.some((x) => /^(Form Panel Gratis|Panel Gratis)/.test(x))) return 'Plataforma';
  if (l.Lead_Status === 'Retargeting Lili' || t.some((x) => /^(Form LiliBank|Form Lili Sep|Cuenta Bancaria - Lili)$/.test(x))) return 'Lili';
  return 'Apertura';
}

/**
 * Qué hay que escribirle al lead. null = nada.
 * vencida: su última reunión pasó hace más de 2 horas, nadie la marcó y no tiene otra agendada.
 */
export function cambioDe(l, { vencida = false } = {}) {
  const pais = paisDe(l);
  const deDaniel = l.Owner?.id === DANIEL_ID;
  const e = l.Etapa_Daniel || null;
  // 6-nov-2026, Ignacio: Daniel llama a todos hasta que llegan a la llamada, también partners y referidos
  // (el responsable de esos sigue siendo Santiago). El lead en inglés sigue afuera: Daniel habla español y portugués.
  if (!e && !deDaniel && l.Idioma === 'English') return null;
  if (!deDaniel && !e) {
    if (!ACTIVOS.has(l.Lead_Status)) return null;
    if (String(l.Created_Time || '').slice(0, 10) < DESDE_ARGENTINA) return null;
  }

  const a = String(l.Asistio_al_Meeting || '').trim();
  const c = {};
  let etapa = e;
  if (a === 'Si') {
    etapa = 'Asistió';
    // Solo los de Brasil pasan a Thais. El argentino queda con su dueño.
    if (deDaniel && pais === 'Brasil') { c.Owner = { id: THAIS_ID }; c.Etapa_Thais = 'Reunião feita'; }
  } else if (a.startsWith('Si,')) {
    etapa = 'Perdido';
  } else if (l.Lead_Status === 'Reunión Agendada') {
    // Sin marcar no es "ya está": vuelve a la lista de Daniel. Si después marcan Asistió, se corrige solo.
    if (!vencida) etapa = 'Agendó';
    else if (!e || e === 'Por llamar' || e === 'Agendó') etapa = 'Reintentando asistencia';
  } else if (l.Lead_Status === 'No Show' && (!e || e === 'Por llamar' || e === 'Agendó')) {
    etapa = 'Reintentando asistencia';
  } else if (!e) {
    etapa = 'Por llamar';
  }
  if (etapa !== e) c.Etapa_Daniel = etapa;
  const paisTablero = pais || 'Otro país';
  if (l.Pa_s_Daniel !== paisTablero) c.Pa_s_Daniel = paisTablero;
  const flujo = flujoDe(l);
  if (l.Flujo_Daniel !== flujo) c.Flujo_Daniel = flujo;
  return Object.keys(c).length ? c : null;
}

/** ¿Hay que sacarlo de la secuencia? Lo marcaron Perdido a mano y sigue recibiendo mensajes. */
export function debeSalir(l) {
  if (l.Etapa_Daniel !== 'Perdido' && l.Etapa_Thais !== 'Perdido') return false;
  // "Asistió sin interés" también cae en Perdido, pero Zoho lo lleva a Nurturing a propósito.
  if (String(l.Asistio_al_Meeting || '').trim().startsWith('Si,')) return false;
  return !SIN_SECUENCIA.has(l.Lead_Status);
}

/** De las reuniones de venta, los leads con la última vencida y sin marcar. */
export function leadsConReunionVencida(reuniones, ahora = Date.now()) {
  const futuras = new Set();
  const vencidas = new Set();
  const dosHoras = 2 * 3600 * 1000;
  const vivas = reuniones.filter((r) => r.What_Id?.id && !/^\[CANCELADA\]/.test(r.Event_Title || ''));
  for (const r of vivas) if (new Date(r.Start_DateTime).getTime() > ahora - dosHoras) futuras.add(r.What_Id.id);
  for (const r of vivas) {
    if (r.Status_del_Meet) continue;
    if (new Date(r.Start_DateTime).getTime() <= ahora - dosHoras && !futuras.has(r.What_Id.id)) vencidas.add(r.What_Id.id);
  }
  return vencidas;
}

export const CAMPOS = 'Full_Name,Owner,Lead_Status,Asistio_al_Meeting,Etapa_Daniel,Etapa_Thais,Pa_s_Daniel,Flujo_Daniel,Idioma,Mobile,Phone,Country,Tipo,Tag,Landing_Origen,Lead_Source,Created_Time';
