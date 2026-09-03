/*
 * Fathom avisa acá cuando termina de procesar una llamada, y esto despierta al
 * coach. Antes habia que esperar hasta la media hora siguiente; ahora la
 * tarjeta sale a los pocos minutos de cortar.
 *
 * IMPORTA para lo que hace el coach: el mensaje post-llamada solo se puede
 * mandar como texto libre mientras la ventana de WhatsApp de 24h siga abierta.
 * Cada hora de demora es una hora menos de esa ventana.
 *
 * POR QUE NO LEE EL CUERPO DEL WEBHOOK:
 * Fathom no publica la forma del payload ni el esquema de firma, asi que
 * depender de eso seria construir sobre algo que no vimos. Este endpoint se usa
 * solo como un "despertate": dispara al worker, que va a buscar los datos a la
 * API de Fathom, que es la fuente autoritativa, y descarta lo que ya publico
 * mirando el blob `coach-publicadas`. Consecuencia buena: es idempotente. Si
 * Fathom manda el aviso dos veces, o si alguien pega la URL de mas, no se
 * publica nada duplicado.
 *
 * SEGURIDAD: pide COACH_WEBHOOK_TOKEN, por query (?s=...) o por header. Es un
 * token propio, distinto del FATHOM_WEBHOOK_SECRET con el que Fathom firma:
 * un secreto de firma no tiene que viajar en una URL, porque las URLs quedan en
 * los logs del servidor. Este endpoint no expone datos ni acepta contenido, asi
 * que lo peor que puede hacer alguien que lo adivine es provocar una corrida
 * que igual iba a ocurrir.
 *
 * La corrida programada de cada hora SE QUEDA, como red: si un aviso se pierde
 * o Fathom tiene un problema, la llamada entra igual un rato despues.
 */

const NOMBRE = 'coach-ventas-background';

export default async (req) => {
  const secreto = process.env.COACH_WEBHOOK_TOKEN;
  if (!secreto) {
    console.error('falta COACH_WEBHOOK_TOKEN: no se acepta ningun aviso');
    return new Response('no configurado', { status: 503 });
  }

  const url = new URL(req.url);
  const recibido = url.searchParams.get('s') || req.headers.get('x-webhook-secret') || '';
  if (recibido !== secreto) return new Response('no autorizado', { status: 401 });

  // El cuerpo se lee solo para dejar rastro de que llego, no para confiar en el.
  let pista = '';
  try {
    const crudo = await req.text();
    const j = JSON.parse(crudo);
    pista = j.title || j.meeting?.title || j.recording_id || j.id || `${crudo.length} bytes`;
  } catch {
    pista = '(cuerpo no legible)';
  }
  console.log(`aviso de Fathom recibido: ${String(pista).slice(0, 80)}`);

  try {
    const r = await fetch(`${url.origin}/.netlify/functions/${NOMBRE}`, { method: 'POST' });
    // 202 = la background arranco. No se espera el resultado: tarda minutos.
    return new Response(JSON.stringify({ despertado: r.status === 202, estado: r.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo despertar al coach', e);
    // 200 igual: si devolvemos error, Fathom reintenta y no hace falta, porque
    // la corrida programada lo va a levantar de todos modos.
    return new Response(JSON.stringify({ despertado: false, error: String(e.message) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
