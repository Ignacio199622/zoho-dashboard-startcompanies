// FILTROS DE LA GUARDIA FUERA DE HORARIO (2-nov-2026)
//
// Funciones puras (sin Zoho ni Blobs) para poder probarlas solas:
// `node scripts/test-guardia.mjs`.
//
// Por que existe: el 29-oct a las 00:12 la guardia le tildo el aviso a Matteo
// Maglia (LLC AM INTERNATIONAL, socio Globo Banks, Bloqueo_de_envio tildado) y
// el 2-nov a las 05:12 a Giancarlos Weill (Tipo de contacto Partner). La regla
// de Zoho "Aviso fuera de horario - Clientes" no tiene condicion y mando
// `fuera_horario_cliente` por el 786 con nuestra marca. Regla de oro: a un
// cliente de un socio no le llega nada nuestro.
//
// Todo va detras de variables de Netlify. Los valores por defecto son los
// SEGUROS: lo que frena mensajes viene prendido, lo que cambia el reloj viene
// apagado.
//
//   GUARDIA_CANDADO_SOCIO          1 (prendido). 0 para apagarlo.
//   GUARDIA_POSIBLE_PARTNER        1 (prendido): el que quiere ser socio NO
//                                  entra a Agendamiento (cadencia de LLC).
//   GUARDIA_MIN_SIN_RESPUESTA      15 (lo de hoy). Minutos que el ultimo
//                                  mensaje entrante tiene que estar sin
//                                  respuesta antes de avisar.
//   GUARDIA_HORAS_ENTRE_AVISOS     12. Nunca dos avisos a la misma persona en
//                                  menos de esto (clave en Blobs). 0 = apagado.
//   GUARDIA_TZ_CONTACTO            0 (apagado). Con 1, ademas de que el equipo
//                                  este cerrado (hora AR), tiene que ser fuera
//                                  de horario en la hora del contacto, y la
//                                  vuelta se le dice en su hora.
//   GUARDIA_FERIADOS               lista yyyy-mm-dd con comas que se suma a los
//                                  feriados de EE.UU. (ej. 2026-12-24,2026-12-31).
import { candadoSocio } from '../matias-candados.js';
import { env } from './entorno.js';

const prendido = (v, porDefecto) => {
  if (v == null || String(v).trim() === '') return porDefecto;
  return /^(1|true|si|sí|on)$/i.test(String(v).trim());
};
const numero = (v, porDefecto) => {
  if (v == null || String(v).trim() === '') return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
};

/** Las opciones de la guardia leidas de las variables (o de un objeto, para probar). */
export function opcionesGuardia(e = env, minutosPorDefecto = 15) {
  return {
    candadoSocio: prendido(e.GUARDIA_CANDADO_SOCIO, true),
    posiblePartnerSinCadencia: prendido(e.GUARDIA_POSIBLE_PARTNER, true),
    minSinRespuesta: numero(e.GUARDIA_MIN_SIN_RESPUESTA, minutosPorDefecto),
    horasEntreAvisos: numero(e.GUARDIA_HORAS_ENTRE_AVISOS, 12),
    tzContacto: prendido(e.GUARDIA_TZ_CONTACTO, false),
    feriadosExtra: feriadosDeTexto(e.GUARDIA_FERIADOS),
  };
}

/** "2026-12-24, 2026-12-31" -> ['2026-12-24', '2026-12-31']; descarta lo que no es fecha. */
export function feriadosDeTexto(txt) {
  return String(txt || '').split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

// ─── Quien es ──────────────────────────────────────────────────────────────

const texto = (v) => String((v && typeof v === 'object' ? v.name : v) || '').trim();

/**
 * La ficha que mira el candado de socio para un CONTACTO: el contacto no tiene
 * `Socio` ni `Partner`; eso vive en la LLC (`Account_Name.Socio`) y en
 * `Nombre_de_Partner`. `Bloqueo_de_envio` puede estar en cualquiera de los dos.
 */
export function fichaParaCandado(registro, cuenta = null) {
  if (!registro) return null;
  return {
    ...registro,
    Partner: registro.Partner ?? registro.Nombre_de_Partner ?? null,
    Socio: registro.Socio ?? cuenta?.Socio ?? null,
    Bloqueo_de_envio: registro.Bloqueo_de_envio === true || cuenta?.Bloqueo_de_envio === true,
  };
}

const POSIBLE_PARTNER = /posible\s+partner/i;
const FORM_SOCIOS = /^form socios/i;

/**
 * 'socio' (cliente de un socio o bloqueado: no se le manda nada), 'cliente',
 * 'posible_partner' (quiere ser socio) o 'lead'. `motivoSocio` viene de
 * candadoSocio sobre la ficha armada.
 */
export function tipoPersona(modulo, registro, motivoSocio = '') {
  if (motivoSocio) return 'socio';
  if (modulo === 'Contacts') return 'cliente';
  const tags = (registro?.Tag || []).map(texto);
  if (POSIBLE_PARTNER.test(texto(registro?.Tipo)) || tags.some((t) => FORM_SOCIOS.test(t) || POSIBLE_PARTNER.test(t))) {
    return 'posible_partner';
  }
  return 'lead';
}

/** El motivo del candado de socio, o '' si se le puede escribir. */
export function motivoSocio(modulo, registro, cuenta = null) {
  const ficha = modulo === 'Contacts' ? fichaParaCandado(registro, cuenta) : registro;
  return candadoSocio(ficha);
}

// ─── El huso del contacto ──────────────────────────────────────────────────
//
// `Codigo_de_Pais` esta vacio en los 81 contactos que recibieron tarea en los
// ultimos 14 dias, asi que el pais sale del prefijo del telefono. +1 (EE.UU. y
// Canada) tiene seis husos: no se adivina y queda en hora AR.
const PREFIJOS = [
  ['1809', 'America/Santo_Domingo'], ['1829', 'America/Santo_Domingo'], ['1849', 'America/Santo_Domingo'],
  ['1787', 'America/Puerto_Rico'], ['1939', 'America/Puerto_Rico'],
  ['598', 'America/Montevideo'], ['595', 'America/Asuncion'], ['591', 'America/La_Paz'],
  ['593', 'America/Guayaquil'], ['506', 'America/Costa_Rica'], ['507', 'America/Panama'],
  ['502', 'America/Guatemala'], ['503', 'America/El_Salvador'], ['504', 'America/Tegucigalpa'],
  ['505', 'America/Managua'], ['351', 'Europe/Lisbon'],
  ['54', 'America/Argentina/Buenos_Aires'], ['52', 'America/Mexico_City'], ['57', 'America/Bogota'],
  ['56', 'America/Santiago'], ['51', 'America/Lima'], ['55', 'America/Sao_Paulo'],
  ['58', 'America/Caracas'], ['53', 'America/Havana'], ['34', 'Europe/Madrid'],
  ['39', 'Europe/Rome'], ['33', 'Europe/Paris'], ['44', 'Europe/London'], ['49', 'Europe/Berlin'],
];
const PAISES = {
  AR: 'America/Argentina/Buenos_Aires', MX: 'America/Mexico_City', CO: 'America/Bogota', CL: 'America/Santiago',
  PE: 'America/Lima', BR: 'America/Sao_Paulo', UY: 'America/Montevideo', PY: 'America/Asuncion',
  BO: 'America/La_Paz', EC: 'America/Guayaquil', VE: 'America/Caracas', ES: 'Europe/Madrid',
  CR: 'America/Costa_Rica', PA: 'America/Panama', GT: 'America/Guatemala', SV: 'America/El_Salvador',
  HN: 'America/Tegucigalpa', NI: 'America/Managua', DO: 'America/Santo_Domingo', PR: 'America/Puerto_Rico',
  IT: 'Europe/Rome', FR: 'Europe/Paris', GB: 'Europe/London', DE: 'Europe/Berlin', PT: 'Europe/Lisbon',
};
export const TZ_AR = 'America/Argentina/Buenos_Aires';

/** El huso del contacto: primero `Codigo_de_Pais` (AR, MX, +52...), si no el prefijo del telefono. null si no se sabe. */
export function husoDelContacto({ codigoPais = '', telefono = '' } = {}) {
  const cp = String(codigoPais || '').trim().toUpperCase().replace(/^\+/, '');
  if (PAISES[cp]) return PAISES[cp];
  if (/^\d+$/.test(cp)) {
    const p = PREFIJOS.find(([pre]) => cp === pre);
    if (p) return p[1];
  }
  const dig = String(telefono || '').replace(/\D/g, '');
  if (!dig) return null;
  const p = PREFIJOS.find(([pre]) => dig.startsWith(pre));
  return p ? p[1] : null;
}

/** Hora, minuto, dia de semana y fecha civil de un instante en un huso. */
export function enZona(fecha, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(fecha).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const iso = `${p.year}-${p.month}-${p.day}`;
  return { iso, hora: Number(p.hour) % 24, minuto: Number(p.minute), dow: new Date(`${iso}T12:00:00Z`).getUTCDay() };
}

/** ¿Es horario habil (9-18, lunes a viernes, sin feriados) en ese huso? */
export function habilEn(fecha, tz, feriados = new Set(), abre = 9, cierra = 18) {
  const z = enZona(fecha, tz);
  if (z.dow === 0 || z.dow === 6 || feriados.has(z.iso)) return false;
  return z.hora >= abre && z.hora < cierra;
}

/**
 * La vuelta dicha en la hora del contacto. `aperturaISO` es el dia (AR) en que
 * abrimos a las 9 AR. Si el contacto esta en AR o no se sabe, devuelve la frase
 * original sin tocar.
 */
export function vueltaEnSuHora(frase, aperturaISO, tz) {
  if (!tz || tz === TZ_AR || !aperturaISO) return frase;
  const instante = new Date(`${aperturaISO}T09:00:00-03:00`);
  const z = enZona(instante, tz);
  const hhmm = z.minuto ? `${z.hora}:${String(z.minuto).padStart(2, '0')}` : `${z.hora}`;
  // Se cambia solo la hora de "a las 9": el dia ("mañana", "el martes 3...") ya
  // esta bien dicho en la mayoria de los casos (diferencias de 1 a 5 horas).
  return String(frase).replace(/a las 9\b/, `a las ${hhmm} (tu hora)`);
}

// ─── La decision ───────────────────────────────────────────────────────────
//
// Una sola funcion decide si sale el WhatsApp, con el motivo escrito para el
// resumen de Slack. El orden importa: el candado de socio va primero, antes de
// cualquier otra cosa, para que se vea en el log aunque tambien sea lead.

/**
 * @param {object} c
 *   tipo           'socio' | 'cliente' | 'posible_partner' | 'lead'
 *   motivoSocio    texto del candado (si tipo = socio)
 *   atendida       una persona del equipo le venia contestando
 *   enCadencia     el lead ya tiene cadencia que le escribe
 *   tieneReunion   tiene reunion agendada
 *   otroNumero     escribio desde un numero distinto al de la ficha
 *   cerro          su ultimo mensaje fue "gracias", "dale"...
 *   ultimoAviso    iso del ultimo aviso a esta persona (memoria de 12 h) o null
 *   habilContacto  true si en la hora del contacto es horario habil (solo con tzContacto)
 *   camposListos   existen los campos en Zoho
 * @returns {{ aviso: boolean, motivo: string, codigo: string, secuencia: boolean }}
 */
export function decidirAviso(c, opciones, ahora = new Date()) {
  const o = opciones;
  const r = (aviso, codigo, motivo) => ({ aviso, codigo, motivo, secuencia: puedeEntrarASecuencia(c, o) });

  if (c.tipo === 'socio') return r(false, 'socio', `candado de socio (${c.motivoSocio}): ni WhatsApp ni cadencia, solo tarea`);
  if (c.tipo === 'lead' || c.tipo === 'posible_partner') {
    return r(false, 'lead', c.tipo === 'posible_partner'
      ? 'posible partner: el aviso es solo para clientes; tarea sin cadencia de LLC'
      : 'es un posible cliente, el aviso automatico es solo para clientes; se le crea la tarea');
  }
  if (c.atendida) return r(false, 'equipo', 'ya le venia contestando alguien del equipo, solo tarea');
  if (c.enCadencia) return r(false, 'cadencia', 'la cadencia le escribe sola, solo tarea');
  if (c.tieneReunion) return r(false, 'reunion', 'ya tiene reunion agendada, solo tarea');
  if (c.otroNumero) return r(false, 'otro_numero', 'escribio desde otro numero, solo tarea');
  if (c.cerro) return r(false, 'cierre', 'cerro la conversacion, solo tarea');
  if (o.horasEntreAvisos > 0 && c.ultimoAviso) {
    const horas = (ahora - new Date(c.ultimoAviso)) / 3600e3;
    if (horas >= 0 && horas < o.horasEntreAvisos) {
      return r(false, 'reciente', `ya recibio un aviso hace ${Math.round(horas * 10) / 10} h (minimo ${o.horasEntreAvisos} h)`);
    }
  }
  if (o.tzContacto && c.habilContacto) return r(false, 'su_horario', 'en su hora es horario habil, solo tarea');
  if (!c.camposListos) return r(false, 'sin_campos', 'faltan los campos de aviso en Zoho');
  return r(true, 'aviso', 'aviso fuera de horario');
}

/** ¿Este lead entra a Agendamiento? Nunca un socio, ni un posible partner (con el filtro prendido), ni un cliente. */
export function puedeEntrarASecuencia(c, o) {
  if (c.tipo === 'lead') return !c.enCadencia && !c.tieneReunion && !!c.secuenciaViva;
  if (c.tipo === 'posible_partner') return !o.posiblePartnerSinCadencia && !c.enCadencia && !c.tieneReunion && !!c.secuenciaViva;
  return false;
}

// ─── Memoria de avisos (12 h) ──────────────────────────────────────────────

/** Saca de la memoria lo que ya no sirve (mas viejo que la ventana o que 7 dias). */
export function podarAvisos(memoria = {}, ahora = new Date(), horas = 12) {
  const corte = ahora.getTime() - Math.max(horas, 1) * 3600e3;
  const out = {};
  for (const [k, iso] of Object.entries(memoria || {})) {
    if (Date.parse(iso) >= corte) out[k] = iso;
  }
  return out;
}

/** La clave de memoria de una persona: el id de la ficha y, aparte, sus ultimos 9 digitos. */
export function clavesAviso(modulo, id, telefono) {
  const dig = String(telefono || '').replace(/\D/g, '').slice(-9);
  return [`${modulo}:${id}`, ...(dig ? [`tel:${dig}`] : [])];
}

/** El ultimo aviso registrado para cualquiera de las claves. */
export function ultimoAvisoDe(memoria, claves) {
  let mejor = null;
  for (const k of claves) {
    const v = memoria?.[k];
    if (v && (!mejor || Date.parse(v) > Date.parse(mejor))) mejor = v;
  }
  return mejor;
}
