// Toda la parametria del agente en un solo lugar.
// Cambiar valores aca no requiere tocar la logica.

export const VENTANAS = {
  // Recordatorio del dia anterior. Se dispara si faltan entre 20h y 28h.
  recordatorio: { desdeH: 20, hastaH: 28 },
  // Confirmacion del mismo dia. Se dispara si faltan entre 1h y 3h.
  confirmacion: { desdeH: 1, hastaH: 3 },
  // Rescate: la reunion ya paso y nadie la marco.
  rescate: { desdeMin: 10, hastaH: 6 },
};

// Guardarrailes duros. El agente nunca los cruza, ni con el cerebro prendido.
export const LIMITES = {
  // Nunca mas de N mensajes por reunion, sumando todas las ventanas.
  maxMensajesPorReunion: 2,
  // Nunca mas de N mensajes por persona por dia, aunque tenga varias reuniones.
  maxMensajesPorPersonaPorDia: 2,
  // Horario permitido EN HORA DEL CLIENTE, no en hora de Argentina.
  horaMinima: 8,
  horaMaxima: 21,
};

// Estados de reunion en los que el agente no toca nada.
export const STATUS_QUE_FRENAN = ['Asistió', 'Asistio', 'Asistió sin interés'];

// Como se detecta un registro de prueba. Filtrado antes de cualquier decision.
export const PATRONES_PRUEBA = [
  /prueba/i,
  /probador/i,
  /\btest\b/i,
  /testeo/i,
  /ejemplo/i,
  /asdasd/i,
  /qa-/i,
];
export const DOMINIOS_INTERNOS = ['@startcompanies.io', '@startcompanies.us'];

// Prefijo telefonico -> zona horaria IANA. Ordenados por longitud al resolver.
// El pais NO viene cargado en el CRM (campo Pa_s vacio), asi que se deriva del telefono.
export const TZ_POR_PREFIJO = {
  '598': 'America/Montevideo',
  '595': 'America/Asuncion',
  '593': 'America/Guayaquil',
  '591': 'America/La_Paz',
  '507': 'America/Panama',
  '506': 'America/Costa_Rica',
  '505': 'America/Managua',
  '504': 'America/Tegucigalpa',
  '503': 'America/El_Salvador',
  '502': 'America/Guatemala',
  '58': 'America/Caracas',
  '57': 'America/Bogota',
  '56': 'America/Santiago',
  '55': 'America/Sao_Paulo',
  '54': 'America/Argentina/Buenos_Aires',
  '52': 'America/Mexico_City',
  '51': 'America/Lima',
  '44': 'Europe/London',
  '49': 'Europe/Berlin',
  '39': 'Europe/Rome',
  '34': 'Europe/Madrid',
  '33': 'Europe/Paris',
  '1': 'America/New_York',
};

// Zona horaria de la operacion (para mostrar horarios del equipo).
export const TZ_OPERACION = 'America/Argentina/Buenos_Aires';
