/*
 * El reloj del vigia: 9:00 y 18:00 Argentina (12:00 y 21:00 UTC), todos los dias.
 * No hace el trabajo: dispara vigia-background.mjs, que llama a Gemini y puede
 * tardar mas de lo que aguanta una funcion normal.
 *
 * Ojo: no hay que esperar el resultado. Una background contesta 202 al toque y
 * sigue sola.
 */
const NOMBRE = 'vigia-background';

export default async (req) => {
  // La URL propia, para no cablear el dominio y que ande igual en previews.
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202;
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar el vigia', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};

// Argentina no cambia de hora: UTC-3 fijo todo el año.
export const config = { schedule: '0 12,21 * * *' };
