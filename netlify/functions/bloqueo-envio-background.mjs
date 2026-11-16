// Una pasada del candado de partners (ver lib/bloqueo-envio.js). Si tildo algo, avisa en #control-crm.
import { env } from './lib/entorno.js';
import { pasadaBloqueo } from './lib/bloqueo-envio.js';
import { CANALES } from './lib/aviso-falla.js';

async function postear(text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANALES[0], text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) console.error('slack', j.error);
}

export default async () => {
  try {
    const r = await pasadaBloqueo({ aplicar: true });
    console.log('bloqueo-envio', JSON.stringify({ ...r, detalle: r.detalle.length }));
    if (r.pendientes) {
      const lista = r.detalle.slice(0, 20).map((x) => `• ${x}`).join('\n');
      await postear(`:lock: *Candado de partners*: ${r.tildados} ficha(s) nuevas bloqueadas (no reciben nada con marca Start Companies)${r.errores ? `, ${r.errores} con error` : ''}.\n${lista}${r.detalle.length > 20 ? `\n… y ${r.detalle.length - 20} más` : ''}`);
    }
  } catch (e) {
    console.error('bloqueo-envio falló', e);
    await postear(`:warning: El candado de partners (bloqueo-envio) falló: ${String(e.message).slice(0, 300)}`);
  }
};
