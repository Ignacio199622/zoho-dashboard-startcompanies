// Cada hora mira si alguien respondio "aprobar" o "rechazar" en el hilo de Slack de la propuesta de
// reglas de Matias (ver lib/matias-aprende.js). Solo cuentan respuestas de personas, no de bots.
// Si MATIAS_APROBADORES (ids de Slack separados por coma) esta cargada, solo cuentan esas personas.
import { propuesta, aprobarPropuesta, descartarPropuesta, respuestasDelHilo } from './lib/matias-aprende.js';
import { avisarFalla } from './lib/aviso-falla.js';
import { env } from './lib/entorno.js';

const VENCE_MS = 72 * 3600e3;

async function responderEnHilo(canal, ts, texto) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: canal, thread_ts: ts, text: texto }),
  }).catch(() => {});
}

export default async () => {
  const ahora = new Date();
  try {
    const p = await propuesta();
    if (!p || p.estado !== 'pendiente' || !p.ts) return new Response('nada pendiente');

    const aprobadores = String(process.env.MATIAS_APROBADORES || '').split(',').map((x) => x.trim()).filter(Boolean);
    const respuestas = (await respuestasDelHilo(p.canal, p.ts))
      .filter((m) => !m.bot_id && m.user && (!aprobadores.length || aprobadores.includes(m.user)));
    // Manda la última respuesta de una persona.
    for (const m of respuestas.reverse()) {
      const t = String(m.text || '').trim().toLowerCase();
      if (/^(aprobar|apruebo|aprobado|ok|dale|s[ií])\b/.test(t)) {
        await aprobarPropuesta(m.user, ahora);
        await responderEnHilo(p.canal, p.ts, `✅ Listo: Matías ya usa estas ${p.reglas.length} reglas (aprobó <@${m.user}>).`);
        return new Response('aprobada');
      }
      if (/^(rechazar|rechazo|rechazado|no)\b/.test(t)) {
        await descartarPropuesta(m.user, 'rechazada', ahora);
        await responderEnHilo(p.canal, p.ts, `🗑️ Descartadas: Matías sigue con sus reglas de antes (rechazó <@${m.user}>).`);
        return new Response('rechazada');
      }
    }

    if (ahora - new Date(p.fecha) > VENCE_MS) {
      await descartarPropuesta('nadie', 'vencida', ahora);
      await responderEnHilo(p.canal, p.ts, '⌛ Nadie respondió en 3 días: descarté la propuesta y Matías sigue con sus reglas de antes.');
      return new Response('vencida');
    }
    return new Response('sin respuesta todavía');
  } catch (e) {
    await avisarFalla('Matías (aprobación de reglas)', e, 'No se pudo revisar si aprobaron las reglas nuevas de Matías.');
    return new Response('fallo, avisado', { status: 200 });
  }
};

export const config = { schedule: '23 * * * *' };
