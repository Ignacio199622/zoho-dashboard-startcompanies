/*
 * EL PORTAL AVISA QUE UNA PERSONA TOMÓ (O DEVOLVIÓ) UNA CONVERSACIÓN.
 *
 * POST { numero, humano: true|false, quien } con la cabecera x-matias-key.
 * Guarda `humano` en la ficha `apertura-<tel>` de Blobs: con eso Matías no contesta,
 * no manda seguimientos ni aperturas a ese teléfono hasta que lo devuelvan.
 */
import { env } from './lib/entorno.js';
import * as matias from './lib/matias.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST', { status: 405 });
  if (!env.MATIAS_INGEST_KEY || req.headers.get('x-matias-key') !== env.MATIAS_INGEST_KEY) {
    return new Response('clave inválida', { status: 401 });
  }
  let cuerpo;
  try { cuerpo = await req.json(); } catch { return new Response('cuerpo ilegible', { status: 400 }); }
  const numero = String(cuerpo.numero || '').replace(/\D/g, '');
  if (!numero) return new Response('falta numero', { status: 400 });
  const humano = Boolean(cuerpo.humano);
  const ahora = new Date();
  await matias.marcarEvento(numero, humano
    ? { humano: true, humanoDesde: ahora.toISOString(), humanoQuien: String(cuerpo.quien || 'portal').slice(0, 60) }
    : { humano: false, humanoHasta: ahora.toISOString() }, ahora);
  await matias.enHilo(numero, humano
    ? `🙋 *${cuerpo.quien || 'Alguien del equipo'} tomó la conversación desde el portal.* Matías se calla en este hilo.`
    : `🤖 *La conversación volvió a Matías* (la devolvió ${cuerpo.quien || 'el portal'}).`).catch(() => {});
  return Response.json({ ok: true, numero, humano });
};

export const config = { path: '/.netlify/functions/matias-humano' };
