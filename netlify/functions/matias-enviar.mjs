/*
 * UNA PERSONA LE ESCRIBE AL LEAD POR EL +52, DESDE EL PORTAL.
 *
 * El portal (api-bot) manda todo por su propio número. Las conversaciones del +52 llegan al
 * portal solo como espejo, así que cuando alguien del equipo contestaba una de esas, el
 * mensaje salía por el otro número y Meta lo rechazaba (131047) o le llegaba al lead desde
 * un número distinto. Con esto el api-bot, si el hilo es de Matías, manda por acá.
 *
 * POST { numero, texto, quien } con la cabecera x-matias-key.
 *   200 { ok:true, id }                      salió por el +52
 *   409 { ok:false, motivo }                 no es un hilo de Matías: que el portal mande por el suyo
 *   422 { ok:false, motivo }                 ventana de 24 h cerrada (el lead no escribió al +52)
 *   502 { ok:false, motivo }                 Meta lo rechazó
 * Deja el mensaje en el hilo, en Slack (🙋 con el nombre) y en el portal (by: human), y marca
 * la ficha como tomada por esa persona (Matías se calla hasta que la devuelvan).
 */
import { env } from './lib/entorno.js';
import * as hilo from './lib/hilo.js';
import * as matias from './lib/matias.js';
import { reflejar as reflejarEnPortal } from './lib/portal.js';

const VENTANA_MS = 24 * 3600e3;

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST', { status: 405 });
  if (!env.MATIAS_INGEST_KEY || req.headers.get('x-matias-key') !== env.MATIAS_INGEST_KEY) {
    return new Response('clave inválida', { status: 401 });
  }
  let cuerpo;
  try { cuerpo = await req.json(); } catch { return Response.json({ ok: false, motivo: 'cuerpo ilegible' }, { status: 400 }); }
  const numero = String(cuerpo.numero || '').replace(/\D/g, '');
  const texto = String(cuerpo.texto || '').trim();
  const quien = String(cuerpo.quien || 'Equipo').slice(0, 60);
  if (!numero) return Response.json({ ok: false, motivo: 'falta numero' }, { status: 400 });
  if (!texto) return Response.json({ ok: false, motivo: 'falta texto' }, { status: 400 });
  const ahora = new Date();

  // ¿Es un hilo de Matías? Solo los números con ficha `apertura-<tel>` (la crea la apertura o
  // el primer mensaje al +52). Sin ficha es una conversación de otro número: el portal manda
  // por el suyo, como siempre.
  const estado = await matias.estadoDe(numero);
  if (!Object.keys(estado).length) {
    return Response.json({ ok: false, motivo: 'no es un hilo de Matías' }, { status: 409 });
  }

  // Texto libre solo dentro de la ventana de 24 h desde el último mensaje del lead al +52.
  const mensajes = await matias.leerHilo(numero, ahora);
  const ultimoDelLead = [...mensajes].reverse().find((m) => m.de === 'cliente');
  if (!ultimoDelLead || ahora - new Date(ultimoDelLead.cuando) > VENTANA_MS) {
    return Response.json({
      ok: false,
      motivo: `ventana de 24 h cerrada: el lead no le escribió al +52 desde ${ultimoDelLead ? ultimoDelLead.cuando.slice(0, 16).replace('T', ' ') + ' UTC' : 'nunca'}. Para escribirle hace falta una plantilla.`,
    }, { status: 422 });
  }

  let id;
  try {
    id = await matias.enviarTexto(numero, texto, { humano: true });
  } catch (e) {
    return Response.json({ ok: false, motivo: `Meta lo rechazó: ${e.message}` }, { status: 502 });
  }

  await hilo.agregar(numero, 'nosotros', texto, ahora);
  // Tomó el hilo (si no lo tenía ya): Matías no contesta ni manda seguimientos hasta que lo devuelvan.
  await matias.marcarEvento(numero, {
    ...(estado.humano ? {} : { humano: true, humanoDesde: ahora.toISOString(), humanoQuien: quien }),
    ultimoHumano: { quien, cuando: ahora.toISOString() },
  }, ahora);
  await matias.enHilo(numero, `🙋 *${quien}* (desde el portal, por el +52)\n> ${texto.split('\n').join('\n> ')}`).catch(() => {});
  // El portal guarda el mensaje como suyo (by: human) y deja la nota en Zoho si la ficha está vinculada.
  await reflejarEnPortal({ numero, de: 'humano', texto, id, cuando: ahora, nombre: undefined, lead: null });
  console.log(`enviado por ${quien} a ${numero}: ${id}`);
  return Response.json({ ok: true, id, numero });
};

export const config = { path: '/.netlify/functions/matias-enviar' };
