// Las decisiones. Cada una devuelve su motivo, para que el reporte pueda
// explicar por que aviso y por que no.
import {
  MINUTOS_SIN_RESPUESTA,
  HORAS_AVISO_VENTANA,
  HORAS_VENTANA_WHATSAPP,
  HORA_INICIO,
  HORA_FIN,
  ES_PRUEBA,
  horaEnArgentina,
  esFinDeSemana,
} from './config.js';

// Para el reclamo de "sin respuesta" el fin de semana NO cuenta: seria echarle
// en cara a alguien que no esta trabajando.
export const enHorarioLaboral = (fecha) => {
  if (esFinDeSemana(fecha)) return false;
  const h = horaEnArgentina(fecha);
  return h >= HORA_INICIO && h < HORA_FIN;
};

/**
 * Primer filtro, sin modelo y sin costo: que conversaciones estan realmente
 * esperando al equipo.
 *
 * `conversation_status__s` lo pone Zoho solo y ya trae la respuesta:
 *   "Responded" = el ultimo que hablo fue el cliente, nadie contesto todavia
 *   "Replied"   = el ultimo que hablo fue el equipo
 * Verificado a mano contra el CRM el 2026-09-03.
 */
export function pendientes(conversaciones, ahora = new Date()) {
  const out = [];
  for (const c of conversaciones) {
    if (c.conversation_status__s !== 'Responded') continue;
    if (!c.message_time__s) continue;

    const cuando = new Date(c.message_time__s);
    const minutos = Math.round((ahora - cuando) / 60000);
    if (minutos < 0) continue;

    const horasVentana = HORAS_VENTANA_WHATSAPP - minutos / 60;
    out.push({
      ...c,
      ref: c.id,
      cuando,
      minutosEsperando: minutos,
      horasEsperando: Math.max(0, Math.round((minutos / 60) * 10) / 10),
      // Cuanto queda de la ventana de 24h de WhatsApp. Pasada, solo se puede
      // escribir con plantilla aprobada por Meta.
      horasDeVentana: Math.round(horasVentana * 10) / 10,
      ventanaCerrada: horasVentana <= 0,
    });
  }
  return out.sort((a, b) => b.minutosEsperando - a.minutosEsperando);
}

/**
 * Con la clasificacion ya hecha, decide si esto se avisa y con que urgencia.
 * Devuelve null cuando no amerita alerta.
 */
export function decidir(conv, clase, ahora = new Date()) {
  const ficha = conv.ficha;
  if (ES_PRUEBA(ficha?.Full_Name, ficha?.Email)) {
    return { avisar: false, motivo: 'registro de prueba' };
  }

  // Un "gracias" no es una alerta por mas que lleve 23h sin contestar y por mas
  // que la ventana de WhatsApp este por cerrarse. La primera corrida en sombra
  // devolvio 11 alertas de las cuales 10 eran esto: si el canal arranca asi,
  // nadie lo mira a la semana.
  if (clase?.categoria === 'ruido') {
    return { avisar: false, motivo: 'ruido' };
  }

  const motivos = [];
  let prioridad = 0;

  if (clase?.categoria === 'venta') {
    motivos.push('señal comercial');
    prioridad = Math.max(prioridad, 3);
  }
  if (clase?.categoria === 'riesgo') {
    motivos.push('riesgo de perder al cliente');
    prioridad = Math.max(prioridad, 3);
  }
  if (clase?.categoria === 'soporte') {
    motivos.push('pide ayuda');
    prioridad = Math.max(prioridad, 2);
  }

  // Sin respuesta: solo se cuenta si el mensaje llego en horario de trabajo y
  // ya pasamos el umbral. Un mensaje de las 2 AM no es culpa de nadie.
  // Para lo operativo el umbral es mucho mas alto: que un cliente mande un
  // documento y nadie le conteste en una hora no es un problema, que nadie lo
  // mire en medio dia si.
  const umbral = clase?.categoria === 'operativo' ? MINUTOS_SIN_RESPUESTA * 8 : MINUTOS_SIN_RESPUESTA;
  const tarde = conv.minutosEsperando >= umbral;
  if (tarde && enHorarioLaboral(conv.cuando) && enHorarioLaboral(ahora)) {
    motivos.push(`${Math.round(conv.minutosEsperando / 60) || '<1'}h sin respuesta`);
    prioridad = Math.max(prioridad, 1);
  }

  // La ventana de WhatsApp por cerrarse sube la urgencia de algo que ya
  // importaba, pero no convierte un "gracias" en una alerta.
  const porVencer = !conv.ventanaCerrada && conv.horasDeVentana <= HORAS_AVISO_VENTANA;
  if (porVencer && prioridad > 0) {
    motivos.push(`quedan ${conv.horasDeVentana}h de ventana`);
    prioridad = Math.max(prioridad, 4);
  }

  if (!motivos.length) return { avisar: false, motivo: clase?.categoria || 'sin motivo' };

  return {
    avisar: true,
    prioridad: Math.max(prioridad, Math.min(clase?.urgencia || 0, 5) - 2),
    motivos,
    porVencer,
  };
}
