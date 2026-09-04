// Que el agente no se pueda morir en silencio.
//
// El silencio de un agente de alertas es identico a "no hay nada pendiente", y
// esa es la trampa: el equipo deja de mirar WhatsApp porque confia en el aviso,
// y si el agente esta muerto hace cuatro dias nadie se entera. Peor que no
// tenerlo.
//
// Tres cosas:
//   1. Si una corrida falla, lo dice en Slack.
//   2. Cuando vuelve despues de un hueco, avisa cuanto estuvo caido.
//   3. Al cierre del dia manda el resumen, que ademas sirve de señal de vida.
import { SLACK_WEBHOOK_URL, webhookDe, HORA_FIN, horaEnArgentina } from './config.js';

// No repetir el mismo fallo cada hora: si Zoho se cayo, con un aviso alcanza.
const HORAS_ENTRE_AVISOS_DE_FALLO = 6;

// Cuanto puede pasar entre corridas antes de considerarlo un hueco. La tarea
// corre cada hora, asi que dos horas y media ya es que algo no anduvo.
const HORAS_DE_HUECO = 2.5;

async function postear(texto, bloques) {
  const url = webhookDe('cx') || SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texto, blocks: bloques }),
    });
    return true;
  } catch {
    // Si el propio webhook esta muerto no hay a quien avisarle. Queda en el log.
    return false;
  }
}

export async function avisarFallo(estado, error, ahora = new Date()) {
  const s = estado.salud || (estado.salud = {});
  const desdeElUltimo = s.ultimoFallo ? (ahora - new Date(s.ultimoFallo)) / 3600000 : Infinity;

  s.fallosSeguidos = (s.fallosSeguidos || 0) + 1;
  if (desdeElUltimo < HORAS_ENTRE_AVISOS_DE_FALLO) return false;

  s.ultimoFallo = ahora.toISOString();
  const texto =
    `🚨 *El agente de conversaciones falló*\n` +
    `${String(error.message || error).slice(0, 400)}\n` +
    `_Van ${s.fallosSeguidos} corridas seguidas fallando. Nadie está recibiendo alertas de WhatsApp._`;
  await postear('🚨 El agente de conversaciones falló', [
    { type: 'section', text: { type: 'mrkdwn', text: texto } },
  ]);
  return true;
}

/** Se llama al empezar una corrida que sí anduvo. */
export async function avisarRecuperacion(estado, ahora = new Date()) {
  const s = estado.salud || (estado.salud = {});
  const avisos = [];

  if (s.fallosSeguidos > 0) {
    avisos.push(`✅ El agente volvió a andar después de ${s.fallosSeguidos} corridas fallidas.`);
    s.fallosSeguidos = 0;
    s.ultimoFallo = null;
  }

  // Hueco: la corrida anterior fue hace mucho mas de lo que deberia. No detecta
  // la caida en el momento (si no corre, no hay quien la detecte), pero avisa
  // al volver, que es cuando alguien puede hacer algo.
  if (s.ultimaCorrida) {
    const horas = (ahora - new Date(s.ultimaCorrida)) / 3600000;
    const hAntes = horaEnArgentina(new Date(s.ultimaCorrida));
    // De 18 a 9 el hueco es normal, no es una caida.
    const eraHorarioLaboral = hAntes >= 9 && hAntes < HORA_FIN;
    if (horas > HORAS_DE_HUECO && eraHorarioLaboral) {
      avisos.push(`⚠️ El agente estuvo ${Math.round(horas)}h sin correr. Lo que entró en ese rato sale ahora.`);
    }
  }

  s.ultimaCorrida = ahora.toISOString();
  for (const a of avisos) await postear(a, [{ type: 'section', text: { type: 'mrkdwn', text: a } }]);
  return avisos;
}

/** Resumen del dia, en la ultima corrida. Ademas de servir, prueba que esta vivo. */
export async function resumenDelDia(estado, resultado, ahora = new Date()) {
  const s = estado.salud || (estado.salud = {});
  const hoy = ahora.toISOString().slice(0, 10);
  // La ultima pasada del dia es la de las 17 (cada 2h desde las 9), asi que el
  // cierre tiene que poder salir desde esa hora y no desde las 18.
  if (horaEnArgentina(ahora) < HORA_FIN - 2) return false;
  if (s.ultimoResumen === hoy) return false;

  s.ultimoResumen = hoy;
  const d = s.delDia || {};
  const texto =
    `🌙 *Cierre del día*\n` +
    `Alertas mandadas: *${d.alertas || 0}*   ·   Ventas en seguimiento: *${resultado.ventasAbiertas || 0}*\n` +
    `Respuestas del equipo aprendidas: *${d.aprendidos || 0}*   ·   Costo del día: *USD ${(d.costo || 0).toFixed(3)}*\n` +
    `_Vuelvo mañana a las 9._`;
  await postear('🌙 Cierre del día', [{ type: 'section', text: { type: 'mrkdwn', text: texto } }]);
  s.delDia = {};
  return true;
}

/** Va sumando lo del dia para el resumen del cierre. */
export function acumular(estado, resultado, ahora = new Date()) {
  const s = estado.salud || (estado.salud = {});
  const hoy = ahora.toISOString().slice(0, 10);
  if (s.diaEnCurso !== hoy) {
    s.diaEnCurso = hoy;
    s.delDia = {};
  }
  const d = s.delDia || (s.delDia = {});
  d.alertas = (d.alertas || 0) + (resultado.alertas?.length || 0);
  d.aprendidos = (d.aprendidos || 0) + (resultado.aprendidos || 0);
  d.costo = (d.costo || 0) + (resultado.costo || 0);
}

/**
 * El miedo real: que el agente parezca andar y no este haciendo nada.
 *
 * Un fallo tira excepcion y se avisa. Lo que no se ve es el agente que corre
 * bien, no encuentra nada y reporta cero, cuando en realidad se rompio la
 * lectura. Y como su silencio es identico a "no hay nada pendiente", nadie se
 * entera.
 *
 * Sobre 10.315 conversaciones siempre hay movimiento en horario laboral. Cuatro
 * pasadas seguidas leyendo cero es raro y merece que alguien lo mire.
 */
const PASADAS_MUDAS_PARA_SOSPECHAR = 4;

export async function vigilarMudez(estado, resultado, ahora = new Date()) {
  const s = estado.salud || (estado.salud = {});

  if (resultado.leidas > 0) {
    s.pasadasMudas = 0;
    s.avisoDeMudez = false;
    return false;
  }

  s.pasadasMudas = (s.pasadasMudas || 0) + 1;
  if (s.pasadasMudas < PASADAS_MUDAS_PARA_SOSPECHAR || s.avisoDeMudez) return false;

  s.avisoDeMudez = true;
  const texto =
    `🔇 *El agente lleva ${s.pasadasMudas} pasadas sin leer una sola conversación.*\n` +
    `No falló: corre y no encuentra nada. En horario laboral eso es raro sobre 10.000 conversaciones.\n` +
    `_Puede que no haya pasado nada, o puede que la lectura del CRM esté rota y nadie se entere._`;
  await postear('🔇 El agente no está leyendo nada', [
    { type: 'section', text: { type: 'mrkdwn', text: texto } },
  ]);
  return true;
}
