// Matias aprende de las conversaciones del dia (ver lib/matias-aprende.js) y PROPONE las reglas en
// Slack. No entran al prompt hasta que alguien responde "aprobar" en el hilo (matias-aprende-revisar).
import { foto } from './lib/matias-reporte.js';
import { aprender, marcarPublicada } from './lib/matias-aprende.js';
import { avisarFalla } from './lib/aviso-falla.js';
import { env } from './lib/entorno.js';

const CANAL = 'C0C1C7PC691';

export default async () => {
  const ahora = new Date();
  try {
    const f = await foto(ahora);
    const hoy = f.contestaron.filter((l) => ahora - new Date(l.contesto) < 26 * 3600e3);
    const r = await aprender(hoy, ahora);
    let texto;
    if (!r.conversaciones) {
      texto = `🧠 Matías no tuvo conversaciones nuevas hoy; sigue con ${r.vigentes?.length ?? r.reglas.length} reglas.`;
    } else {
      const vigentes = new Set(r.vigentes || []);
      const nuevas = new Set(r.reglas);
      const suma = r.reglas.filter((x) => !vigentes.has(x));
      const saca = (r.vigentes || []).filter((x) => !nuevas.has(x));
      if (!suma.length && !saca.length) {
        texto = `🧠 Matías leyó ${r.conversaciones} conversaciones de hoy y no cambia nada: sigue con ${r.reglas.length} reglas.\n_${r.resumen}_`;
      } else {
        texto =
          `🧠 *Matías propone cambiar sus reglas* (leyó ${r.conversaciones} conversaciones de hoy).\n_${r.resumen}_\n\n` +
          (suma.length ? `*Suma:*\n${suma.map((x) => `➕ ${x}`).join('\n')}\n\n` : '') +
          (saca.length ? `*Saca:*\n${saca.map((x) => `➖ ${x}`).join('\n')}\n\n` : '') +
          `👉 Respondé *aprobar* en este hilo para que las empiece a usar, o *rechazar* para descartarlas. ` +
          `Si nadie responde en 3 días, se descartan solas.`;
      }
    }
    const rs = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: CANAL, text: texto }),
    });
    const js = await rs.json().catch(() => ({}));
    if (!js.ok) console.log(`slack: ${js.error}`);
    else if (r.conversaciones) await marcarPublicada(js.channel || CANAL, js.ts);
    console.log(`matias aprende: ${r.conversaciones} conversaciones, ${r.reglas.length} reglas propuestas`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await avisarFalla('Matías (el aprendizaje del SDR)', e, 'Matías no propuso reglas nuevas hoy.');
    return new Response('fallo, avisado', { status: 200 });
  }
};
