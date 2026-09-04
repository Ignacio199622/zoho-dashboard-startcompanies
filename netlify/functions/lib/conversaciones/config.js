import { env } from './entorno.js';

// ─── Modelo ────────────────────────────────────────────────────────────────
// Gemini Flash alcanza de sobra: los mensajes de WhatsApp son de una linea.
// Pro cuesta 8x mas y no clasifica mejor "me interesa otra LLC".
export const MODELO_GEMINI = env.MODELO_GEMINI || 'gemini-3.8-flash';

// USD por millon de tokens. Estimado, sirve para ver el orden de magnitud
// del gasto en el reporte, no para facturar.
export const PRECIO = { entrada: 0.3, salida: 2.5 };

// ─── Ventana de lectura ────────────────────────────────────────────────────
// Cada corrida pide a Zoho solo lo modificado desde la corrida anterior
// (header If-Modified-Since). Si nunca corrio, arranca mirando estas horas.
export const HORAS_PRIMERA_CORRIDA = Number(env.HORAS_PRIMERA_CORRIDA || 12);

// Colchon hacia atras sobre el ultimo corte, por si algun registro entra con
// unos segundos de retraso respecto de su modified_time.
export const MINUTOS_SOLAPE = 3;

// ─── Umbrales de las alarmas ───────────────────────────────────────────────
// Sin respuesta: cuantos minutos puede quedar un mensaje del cliente sin que
// nadie conteste antes de avisar. Se cuenta solo dentro del horario de trabajo.
export const MINUTOS_SIN_RESPUESTA = Number(env.MINUTOS_SIN_RESPUESTA || 45);

// La ventana de WhatsApp dura 24h desde el ultimo mensaje del cliente. Cuando
// falten menos que esto para que se cierre, la alerta pasa a urgente: despues
// solo se puede escribir con plantilla aprobada.
export const HORAS_AVISO_VENTANA = Number(env.HORAS_AVISO_VENTANA || 4);
export const HORAS_VENTANA_WHATSAPP = 24;

// Horario del equipo, en hora de Argentina. El agente NO avisa fuera de esto:
// corre de 9 a 18, se corta, y retoma al otro dia a las 9. Lo que entra de noche
// no se pierde, se acumula y sale en la primera pasada de la mañana.
export const TZ_EQUIPO = 'America/Argentina/Buenos_Aires';
export const HORA_INICIO = Number(env.HORA_INICIO || 9);
// 19 y no 18 porque el limite es exclusivo: asi la pasada de las 18:00 todavia
// avisa, y la primera que queda afuera es la de las 19.
export const HORA_FIN = Number(env.HORA_FIN || 19);

// El agente descansa el fin de semana: corta el viernes a las 18 y vuelve el
// lunes a las 9. Lo que entra sabado y domingo no se pierde, se acumula y sale
// entero en la primera pasada del lunes.
export const AVISAR_FIN_DE_SEMANA = env.AVISAR_FIN_DE_SEMANA === 'true';

/** Hora que marca el reloj del equipo en ese instante. */
export const horaEnArgentina = (fecha = new Date()) =>
  Number(
    new Intl.DateTimeFormat('es-AR', { timeZone: TZ_EQUIPO, hour: '2-digit', hour12: false }).format(fecha)
  );

export const esFinDeSemana = (fecha = new Date()) =>
  ['Sat', 'Sun'].includes(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ_EQUIPO, weekday: 'short' }).format(fecha)
  );

/** ¿Corresponde que el agente avise ahora? */
export function estaAbierto(fecha = new Date()) {
  const h = horaEnArgentina(fecha);
  if (h < HORA_INICIO || h >= HORA_FIN) return { abierto: false, motivo: `son las ${h} en Argentina` };
  if (!AVISAR_FIN_DE_SEMANA && esFinDeSemana(fecha)) {
    return { abierto: false, motivo: 'fin de semana, vuelve el lunes a las 9' };
  }
  return { abierto: true };
}

// ─── Las ventas no se sueltan ──────────────────────────────────────────────
// Una venta NO se cierra porque alguien conteste. El caso que lo motivo: a David
// le contestaron "desde el mismo panel podes gestionarla" el 27 de agosto y ahi
// murio; pasaron cuatro dias hasta que alguien se dio cuenta a mano.
//
// Por eso estos temas quedan en seguimiento aunque el equipo ya haya respondido,
// y el agente vuelve a insistir hasta que la venta se cierre de verdad.
// `renovacion` esta aca porque una renovacion con el link de pago mandado y sin
// pagar es una venta que se muere igual que cualquier otra.
export const TEMAS_QUE_NO_SE_SUELTAN = ['venta_nueva', 'partnership', 'referidos', 'renovacion'];

// Cada cuantos dias insistir. La lista se va gastando y el ultimo valor se
// repite para siempre: encima al principio, mas espaciado despues, pero nunca
// se olvida. Insistir todos los dias sobre algo de hace un mes es ruido;
// dejar de insistir es volver al problema original.
export const DIAS_INSISTENCIA_VENTA = (env.DIAS_INSISTENCIA_VENTA || '2,2,3,7')
  .split(',')
  .map((d) => Number(d.trim()))
  .filter((d) => d > 0);

// ─── Antirruido ────────────────────────────────────────────────────────────
// Seguimiento: si se aviso y nadie contesto, cuando volver a insistir. Son horas
// contadas desde el PRIMER aviso. Con dos entradas, el agente insiste dos veces
// y despues se calla: si a las 24h nadie lo tomo, el problema no es la alerta.
export const HORAS_RECORDATORIO = (env.HORAS_RECORDATORIO || '4,24')
  .split(',')
  .map((h) => Number(h.trim()))
  .filter((h) => h > 0);

// Tope duro de alertas por corrida. Si un dia algo se dispara, preferimos
// avisar que hay 200 pendientes antes que empapelar el canal con 200 mensajes.
export const MAX_ALERTAS_POR_CORRIDA = Number(env.MAX_ALERTAS_POR_CORRIDA || 15);

// Registros de prueba: no alertan.
export const ES_PRUEBA = (nombre = '', mail = '') =>
  /prueba|test/i.test(nombre) || /@startcompanies\.(io|net)$/i.test(mail || '');

// ─── Quién atiende qué ─────────────────────────────────────────────────────
// Definido por Ignacio el 2026-09-03. El ruteo va por TEMA y no por dueño del
// registro: el 67% de las conversaciones tienen como dueño la cuenta compartida
// "Start Companies Staff", asi que el dueño no dice nada de quien deberia
// atenderla.
export const EQUIPOS = {
  ventas: { nombre: 'Ventas', personas: ['Santiago'] },
  cx: { nombre: 'CX', personas: ['Camila', 'Guadalupe'] },
  admin: { nombre: 'Administración', personas: ['Ignacio Campo', 'Pablo'] },
  referidos: { nombre: 'Referidos', personas: ['Ignacio Campo', 'Santiago'] },
};

// El primero de la lista es a quien le toca; los que siguen van en copia.
// Camila y Guadalupe son la primera linea de todo lo que no es venta nueva:
// atienden ellas y escalan a Ignacio Campo y Pablo cuando hace falta.
export const RUTEO = {
  venta_nueva: ['ventas'],
  partnership: ['ventas'],
  referidos: ['referidos'],
  renovacion: ['cx', 'admin'],
  administrativo: ['cx', 'admin'],
  bancario: ['cx'],
  cx: ['cx'],
};

// Un cliente enojado es un problema de retencion aunque el tema sea bancario o
// administrativo. Con esto, CX recibe copia de los riesgos que se van a otro canal.
export const COPIA_CX_EN_RIESGO = env.COPIA_CX_EN_RIESGO !== 'false';

// Para que la alerta arranque con un @ de verdad hay que poner el ID de Slack de
// cada uno (en Slack: perfil → ... → Copiar id de miembro). Sin esto se nombra
// a la persona en texto plano, que igual funciona pero no notifica.
export const MENCIONES = {
  Santiago: env.SLACK_ID_SANTIAGO || null,
  Camila: env.SLACK_ID_CAMILA || null,
  Guadalupe: env.SLACK_ID_GUADALUPE || null,
  'Ignacio Campo': env.SLACK_ID_IGNACIO_CAMPO || null,
  Pablo: env.SLACK_ID_PABLO || null,
};

export const nombrar = (persona) =>
  MENCIONES[persona] ? `<@${MENCIONES[persona]}>` : persona;

// ─── Slack ─────────────────────────────────────────────────────────────────
// Sin webhook el agente corre en modo sombra: calcula todo y no avisa a nadie.
// Se puede arrancar con un solo canal (SLACK_WEBHOOK_URL) y despues separar por
// equipo sin tocar codigo, agregando los webhooks de abajo.
export const SLACK_WEBHOOK_URL = env.SLACK_WEBHOOK_URL || null;

const WEBHOOK_POR_EQUIPO = {
  ventas: env.SLACK_WEBHOOK_VENTAS,
  cx: env.SLACK_WEBHOOK_CX,
  admin: env.SLACK_WEBHOOK_ADMIN,
  referidos: env.SLACK_WEBHOOK_REFERIDOS,
};

export const webhookDe = (equipo) => WEBHOOK_POR_EQUIPO[equipo] || SLACK_WEBHOOK_URL || null;

export const HAY_SLACK = Boolean(SLACK_WEBHOOK_URL || Object.values(WEBHOOK_POR_EQUIPO).some(Boolean));

export const ZOHO_UI = 'https://crm.zoho.com/crm/org878580932/tab';
