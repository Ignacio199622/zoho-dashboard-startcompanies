/*
 * El reloj del agente de llamadas. No hace el trabajo: lo dispara.
 *
 * El trabajo esta en `agente-llamadas-background.mjs`. Van separados desde el
 * 5-sep-2026 porque como funcion sincronica no entraba en los 60 segundos que
 * da Netlify: los logs mostraban `Duration: 60424 ms` corrida tras corrida.
 *
 * Lo que costo tenerlos juntos: la lista de llamadas ya procesadas se guardaba
 * recien al final del loop, asi que al morir no se guardaba nunca y a la hora
 * siguiente se analizaban las mismas llamadas y se les escribia OTRA nota en
 * Zoho. 85 notas "Analisis de llamada" de mas, 38 sobre un solo lead, hasta que
 * se detecto el 5-sep. Si alguna vez se vuelve a juntar, vuelve a pasar.
 */

const NOMBRE = 'agente-llamadas-background';

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
    console.error('no se pudo disparar agente-llamadas', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Cada hora en punto. Con ~20 llamadas por semana sobra de lejos.
export const config = { schedule: '0 * * * *' };
