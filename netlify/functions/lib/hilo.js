/*
 * LA MEMORIA CORTA DE CADA CHAT.
 *
 * El problema que resuelve, medido el 9-sep-2026: en la primera hora en vivo
 * entraron 26 mensajes de clientes y el bot no contesto ninguno. No fallo nada.
 * Lo que llega no son preguntas enteras, son pedazos de una charla ya empezada:
 *
 *   "a nombre mio"   "y de la llc"   "entro a shopify y ya?"   "me avisan"
 *
 * Sueltos no significan nada, y el modelo elegia "ninguna", que es lo correcto.
 * Con los mensajes de arriba, algunos SI se pueden contestar.
 *
 * ─── POR QUE NO SE LEE DE ZOHO ─────────────────────────────────────────────
 *
 * Porque no se puede: `messages__s` guarda UN registro por conversacion con
 * solo el ultimo mensaje. No hay historial por API. Pero el webhook ve pasar
 * todos los mensajes, asi que el historial lo armamos nosotros.
 *
 * ─── LO QUE ESTO NO ES ─────────────────────────────────────────────────────
 *
 * No es un registro de la conversacion ni una fuente de verdad: es una ayuda
 * para desambiguar el mensaje de ahora. Se guarda poco, vence rapido y si se
 * pierde no pasa nada, se vuelve al comportamiento de antes. Por eso ningun
 * error de aca puede cortar una respuesta.
 */
import { claveTel } from './tel-clave.js';
import { getStore } from '@netlify/blobs';

/** Cuantos mensajes se guardan por conversacion. */
export const LARGO = 10;

/**
 * Despues de esto, lo de antes ya no es contexto: es otra conversacion. Alguien
 * que escribe hoy por un tema nuevo no tiene que arrastrar lo de la semana
 * pasada.
 */
export const HORAS_DE_VIDA = 12;

const almacen = () => getStore({ name: 'autorespuesta', consistency: 'strong' });

// El numero llega distinto segun de donde venga (con +, sin +, con el 9
// argentino). Se normaliza a solo digitos para que sea siempre la misma clave.
const clave = (numero) => `hilo-${claveTel(numero)}`;

/** Los mensajes previos de esta conversacion, del mas viejo al mas nuevo. */
export async function leer(numero, ahora = new Date()) {
  try {
    const guardado = await almacen().get(clave(numero), { type: 'json' });
    const corte = ahora.getTime() - HORAS_DE_VIDA * 3600e3;
    return (guardado || []).filter((m) => m?.texto && new Date(m.cuando).getTime() > corte);
  } catch {
    return [];
  }
}

/**
 * Suma un mensaje al hilo. `de` es 'cliente' o 'nosotros'.
 *
 * Nunca tira: si el almacen falla, el bot pierde contexto pero sigue
 * contestando, que es exactamente como funcionaba antes de que esto existiera.
 */
export async function agregar(numero, de, texto, ahora = new Date()) {
  if (!texto) return;
  try {
    const previos = await leer(numero, ahora);
    const nuevos = [...previos, { de, texto: String(texto).slice(0, 500), cuando: ahora.toISOString() }];
    await almacen().setJSON(clave(numero), nuevos.slice(-LARGO));
  } catch {
    // A proposito en silencio: ver el comentario de arriba.
  }
}
