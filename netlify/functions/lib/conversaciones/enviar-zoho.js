// ENVIO POR ZOHO, CON PLANTILLA.
//
// La alternativa a `enviar.js` (Cloud API de Meta), que quedo cerrada porque el
// numero esta onboardeado a traves de Zoho como Business Solution Provider:
// desde una app propia Meta devuelve (#200) aunque el token tenga todos los
// permisos. Probado el 9-sep-2026, incluso suscribiendo la app a la WABA.
//
// Este modulo expone la MISMA firma que `mandarTexto` de `enviar.js`:
//
//     mandar(numero, texto) -> { ok, id, error }
//
// asi que `autorespuesta.js` no cambia. El dia que Zoho abra una API de texto
// libre, se cambia el modulo y nada mas.
//
// ─── COMO FUNCIONA ─────────────────────────────────────────────────────────
//
// El agente NO manda el mensaje: escribe el texto en `Respuesta_Automatica` y
// tilda `Enviar_Respuesta`. Esa edicion dispara la regla de Zoho, que manda la
// plantilla aprobada con el texto adentro. Es el mismo mecanismo de la guardia
// fuera de horario, que corre en produccion desde el 7-sep-2026.
//
// Despues destilda la casilla, para que la proxima vez pueda volver a
// dispararse. La guardia hace exactamente esta secuencia, verificada en el
// timeline de un cliente real:
//
//     updated  ->  messagenotificationsent  ->  updated
//
// ─── EL LIMITE QUE HAY QUE TENER PRESENTE ──────────────────────────────────
//
// El texto viaja dentro de una variable de plantilla, y ahi WhatsApp no acepta
// NI UN salto de linea. Ni uno solo: no es que colapse los dobles, es que si
// queda cualquier salto adentro de la variable, Meta rechaza el mensaje entero.
//
// Del lado nuestro eso no se ve. Zoho guarda el campo, la regla dispara, la
// bitacora dice "enviado" y el cliente no recibe nada. Se midio el 9-sep-2026:
// el mismo texto con saltos no llega, y sin saltos llega.
//
// Por eso se aplana TODO a una sola linea. Las vinetas quedan de separador
// ("Incluye: • uno • dos"), que se lee mas apretado pero se entiende. Es el
// precio de este camino: por texto libre no haria falta.

import { marcarRespuestaAutomatica, limpiarRespuestaAutomatica } from './escritura.js';

/** Tope de WhatsApp para el contenido de una variable de plantilla. */
export const MAX_VARIABLE = 1024;

/**
 * Deja el texto como lo acepta una variable de plantilla de WhatsApp: una sola
 * linea, sin tabulaciones y sin espacios de mas.
 *
 * Si no entra en `MAX_VARIABLE` se corta en el ultimo espacio, no en la mitad
 * de una palabra. Hoy la entrada mas larga son 784 caracteres, asi que no
 * deberia pasar nunca: si pasa, es que alguien escribio una entrada muy larga.
 */
export function aplanar(texto) {
  const plano = String(texto || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (plano.length <= MAX_VARIABLE) return plano;
  const cortado = plano.slice(0, MAX_VARIABLE);
  const corte = cortado.lastIndexOf(' ');
  return (corte > MAX_VARIABLE * 0.8 ? cortado.slice(0, corte) : cortado).trim();
}

/**
 * Manda la respuesta a traves de Zoho.
 *
 * A diferencia de la Cloud API, esto necesita saber SOBRE QUE REGISTRO escribir,
 * no solo el numero. Por eso se construye con el modulo y el id de la ficha.
 *
 *     const mandar = porZoho(conversacion.ficha);
 *     await mandar(numero, texto);
 */
export function porZoho(ficha) {
  return async function mandar(_numero, texto) {
    if (!ficha?.id || !ficha?.modulo) {
      return { ok: false, error: 'sin ficha: no se sabe en que registro escribir' };
    }
    const cuerpo = aplanar(texto);
    if (!cuerpo) return { ok: false, error: 'texto vacio despues de aplanar' };

    try {
      const r = await marcarRespuestaAutomatica(ficha.modulo, ficha.id, cuerpo);
      if (!r.ok) return { ok: false, error: r.motivo || 'Zoho no guardo los campos' };

      // La casilla se destilda siempre, aunque falle algo despues: si queda
      // tildada, el proximo intento no dispara la regla y el mensaje no sale.
      await limpiarRespuestaAutomatica(ficha.modulo, ficha.id).catch(() => {});

      // Zoho no devuelve el id del mensaje de WhatsApp. Se identifica por el
      // registro y el momento.
      return { ok: true, id: `${ficha.modulo}:${ficha.id}` };
    } catch (e) {
      return { ok: false, error: String(e.message) };
    }
  };
}
