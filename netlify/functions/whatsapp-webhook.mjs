/*
 * EL TIMBRE. Meta avisa acá cuando entra un WhatsApp.
 *
 * Reemplaza al cron de cada 10 minutos: el mensaje llega en el momento y la
 * respuesta sale en segundos. Decision de Ignacio (2026-09-09): el bot es
 * siempre la primera voz.
 *
 * Meta pega dos veces distintas en esta URL:
 *
 *   GET   una sola vez, al configurar el webhook. Manda un `hub.challenge` y
 *         espera que se lo devolvamos tal cual, para probar que la URL es
 *         nuestra. Si no coincide el token, Meta no la guarda.
 *   POST  cada vez que pasa algo: un mensaje entrante, un cambio de estado.
 *
 * ─── POR QUE CONTESTA 200 ANTES DE HACER NADA ──────────────────────────────
 *
 * Meta espera el 200 en pocos segundos. Si tarda, reintenta, y un reintento
 * sobre un agente que manda WhatsApp significa mandarlo dos veces. Por eso esta
 * funcion no trabaja: acusa recibo y le pasa la pelota a la background, igual
 * que `conversaciones.mjs`.
 *
 * ─── OJO CON ZOHO ──────────────────────────────────────────────────────────
 *
 * Zoho tambien recibe estos webhooks: es el proveedor del numero. Que estemos
 * suscriptos nosotros NO le saca los suyos, Meta los manda a las dos apps. Lo
 * verificamos el 9-sep: suscribir la app propia devolvio success y no afecto
 * la integracion del CRM.
 */

const NOMBRE = 'whatsapp-webhook-background';

export default async (req) => {
  const url = new URL(req.url);

  // 1. La verificacion de Meta, una sola vez.
  if (req.method === 'GET') {
    const modo = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const reto = url.searchParams.get('hub.challenge');
    if (modo === 'subscribe' && token && token === process.env.META_WEBHOOK_TOKEN) {
      return new Response(reto, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    console.error('verificacion rechazada: el token no coincide');
    return new Response('forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let cuerpo = null;
  try {
    cuerpo = await req.json();
  } catch {
    // Un cuerpo ilegible no se reintenta: se acusa recibo y se descarta.
    return new Response('ok', { status: 200 });
  }

  // Se dispara el trabajo sin esperarlo. La background contesta 202 al toque.
  try {
    const destino = `${url.origin}/.netlify/functions/${NOMBRE}`;
    await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
  } catch (e) {
    // Aunque falle el disparo se contesta 200: si devolvemos error, Meta
    // reintenta y el cliente puede recibir la respuesta dos veces.
    console.error('no se pudo disparar el worker', e);
  }

  return new Response('ok', { status: 200 });
};

export const config = { path: '/whatsapp' };
