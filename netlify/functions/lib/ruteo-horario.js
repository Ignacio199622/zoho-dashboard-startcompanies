/*
 * RUTEO EN HORARIO (Ignacio, 5-nov-2026: "a todos los retargeting comercial y todo eso en horario
 * hasta las 21 de la noche de todos los paises").
 *
 * Por qué: las ~45 reglas de cadencia de Leads programan sus mensajes "a los N días hábiles" y Zoho
 * los manda A LA MISMA HORA en que el lead entró a la etapa (no deja elegir hora). Las transiciones
 * automáticas del blueprint "Retargeting Apertura" heredan esa hora también. Medido 5-nov: 209 de
 * 685 mensajes salieron fuera de 9-21 h local (España 42/66).
 *
 * Cómo: las reglas de ruteo ya no ponen Lead_Status: sus acciones "Estado - X" escriben el campo
 * Estado_pendiente. Esto lo aplica (Lead_Status = pendiente, POR LA API CON WORKFLOWS, que dispara
 * las mismas reglas que antes) cuando en el país del lead son entre 10 y 20 h. Toda la cadencia
 * queda anclada a esa hora. El lead recién creado (form, WhatsApp) se aplica en la próxima vuelta (2 min) a cualquier hora: el primer mensaje sale en el momento.
 *
 * Candados: si el lead ya cambió de etapa por otro lado (reservó, lo movió alguien) no se pisa: solo
 * se limpia el pendiente. Si lleva más de 16 h esperando (falla, país raro) se aplica igual.
 * RUTEO_HORARIO_APLICAR=0 lo deja en modo vista. Para volver atrás: ver crm/auditoria/salidas/
 * ruteo-horario-antes.json (las acciones de campo originales) y apagar esta función.
 */
const VENTAS = /^(Reunión Agendada|No Show|En Calificación|Calificado|No Calificado|Cierrado ganado|Cerrado ganado|Cerrado perdido|Not Qualified|Junk Lead|Lost Lead|Fuera de flujo)$/i;
export const DESDE = 10, HASTA = 20, ESPERA_MAX_H = 16, RECIEN_MIN = 30;
// Prefijo de teléfono -> zona horaria. El más largo gana. Sin teléfono o sin match: Buenos Aires.
const ZONAS = {
  '54': 'America/Argentina/Buenos_Aires', '55': 'America/Sao_Paulo', '56': 'America/Santiago', '57': 'America/Bogota',
  '58': 'America/Caracas', '51': 'America/Lima', '52': 'America/Mexico_City', '53': 'America/Havana',
  '591': 'America/La_Paz', '593': 'America/Guayaquil', '595': 'America/Asuncion', '598': 'America/Montevideo',
  '502': 'America/Guatemala', '503': 'America/El_Salvador', '504': 'America/Tegucigalpa', '505': 'America/Managua',
  '506': 'America/Costa_Rica', '507': 'America/Panama', '509': 'America/Port-au-Prince',
  '1': 'America/New_York', '1809': 'America/Santo_Domingo', '1829': 'America/Santo_Domingo', '1849': 'America/Santo_Domingo', '1787': 'America/Puerto_Rico', '1939': 'America/Puerto_Rico',
  '34': 'Europe/Madrid', '351': 'Europe/Lisbon', '39': 'Europe/Rome', '33': 'Europe/Paris', '49': 'Europe/Berlin', '44': 'Europe/London', '41': 'Europe/Zurich', '31': 'Europe/Amsterdam', '32': 'Europe/Brussels',
};
const PREFIJOS = Object.keys(ZONAS).sort((a, b) => b.length - a.length);

export function zonaDe(lead) {
  const d = String(lead.Mobile || lead.Phone || '').replace(/\D/g, '');
  if (d.length >= 8) for (const p of PREFIJOS) if (d.startsWith(p)) return ZONAS[p];
  return 'America/Argentina/Buenos_Aires';
}

export function horaLocal(zona, ahora = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ahora).split(':').map(Number);
  return h + m / 60;
}

/** Qué hacer con un lead que tiene Estado_pendiente. */
export function decidir(lead, ahora = new Date()) {
  const pendiente = lead.Estado_pendiente;
  if (!pendiente) return null;
  const zona = zonaDe(lead);
  const hora = horaLocal(zona, ahora);
  // Si mientras esperaba reservó o pasó a reunión / venta / descarte, no se pisa: solo se limpia.
  // Cualquier otra etapa (Nuevo MQL, Captación, Retargeting...) sí se mueve: es lo que pidió la regla.
  const estado = lead.Lead_Status || '';
  if (lead.reserva || VENTAS.test(estado)) {
    return { accion: 'limpiar', motivo: `ya está en ${estado || 'reserva'}`, zona, hora };
  }
  const esperaH = (ahora - new Date(lead.Created_Time || ahora)) / 36e5;
  // Recién llegado (form, WhatsApp, reserva): el primer mensaje sale en el momento, a cualquier hora
  // (Ignacio 5-nov: "deberia llegar al momento"). Solo esperan los cambios de etapa posteriores.
  if (esperaH * 60 < RECIEN_MIN) return { accion: 'aplicar', motivo: `recién entró (${Math.round(esperaH * 60)} min)`, zona, hora };
  if (hora >= DESDE && hora < HASTA) return { accion: 'aplicar', motivo: `${hora.toFixed(1)} h en ${zona}`, zona, hora };
  // El tope es para leads nuevos (si algo falla no quedan sin cadencia). Uno viejo que cambia de etapa de noche espera a la mañana.
  if (esperaH > ESPERA_MAX_H && esperaH < 72) return { accion: 'aplicar', motivo: `esperó ${Math.round(esperaH)} h (tope)`, zona, hora };
  return { accion: 'esperar', motivo: `${hora.toFixed(1)} h en ${zona}`, zona, hora };
}
