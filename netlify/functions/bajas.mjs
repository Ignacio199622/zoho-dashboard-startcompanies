/*
 * El reloj de las bajas de WhatsApp. No hace el trabajo: lo dispara.
 *
 * Va aparte del agente de conversaciones a proposito. Aquel duerme de noche y
 * los fines de semana porque avisa a personas que no estan trabajando; una baja
 * no espera al lunes: el cliente pidio salir y la cadencia le sigue mandando.
 */

const NOMBRE = 'bajas-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202; // 202 = background aceptada
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo disparar bajas', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Cada 15 minutos, TODO EL DIA, todos los dias. Sin ventana horaria: la cadencia
// de Zoho tampoco la tiene, y entre que el cliente pide la baja y la proxima
// corrida es todo tiempo en el que le puede llegar otro mensaje.
//
// A y 5/20/35/50 para no pisar a los otros agentes, que corren en punto, a y 15
// y a y 30.
export const config = { schedule: '5,20,35,50 * * * *' };
