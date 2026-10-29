/*
 * El reloj de la deduccion de canal por calendario. No hace el trabajo, lo dispara.
 *
 * El trabajo esta en canal-clientes-background.mjs y no entra en una funcion
 * sincronica: hay que traer 8.466 leads, 3.511 eventos y 1.073 clientes, que son
 * unas 70 llamadas a Zoho. El techo de una funcion normal de Netlify son 60
 * segundos, y pasarse no da error: la corrida se corta a la mitad, deja el
 * trabajo por la mitad y no queda rastro de por que.
 *
 * Una vez por dia alcanza de sobra: entran ~30 clientes nuevos por mes.
 */
const NOMBRE = 'canal-clientes-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202;
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status, cuando: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo disparar la deduccion de canal', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};

// 06:20 UTC, de madrugada aca: nadie esta tocando el CRM y no se pisa con los
// agentes de la mañana.
export const config = { schedule: '20 6 * * *' };
