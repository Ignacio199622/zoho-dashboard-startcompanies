/*
 * EL GRITO. Cuando un agente se cae, que se entere alguien.
 *
 * El 9-sep-2026 la guardia de fuera de horario estuvo rota media hora y en los
 * logs de Netlify se veia una linea de arranque vacia, exactamente igual que
 * una corrida sana. Nadie se entero hasta que un cliente pregunto por que no le
 * habian contestado.
 *
 * Un agente que se muere en silencio es peor que uno que se cae a los gritos:
 * el tablero muestra actividad y todo parece normal.
 *
 * ─── POR QUE NO ALCANZA CON console.error ──────────────────────────────────
 *
 * Porque nadie mira los logs de Netlify hasta que ya hay un problema. El aviso
 * tiene que ir a donde el equipo ya esta.
 */
import { env } from './entorno.js';

export const CANALES = [env.SLACK_CANAL_FALLAS || '#control-crm', env.SLACK_CANAL].filter(Boolean);
const HAY_SLACK = Boolean(env.SLACK_BOT_TOKEN);

const corta = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

async function postear(cuerpo) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}

/**
 * Avisa que una corrida se cayo. Nunca tira: si Slack tambien falla, lo unico
 * peor que un agente roto seria que el aviso de que esta roto rompa otra cosa.
 *
 * @param {string} agente  como se llama, para que se entienda de que se habla
 * @param {Error|string} error
 * @param {string} [pista] que mirar primero
 */
export async function avisarFalla(agente, error, pista) {
  const mensaje = String(error?.message || error || 'sin detalle');
  console.error(`${agente}: la corrida fallo`, error);
  if (!HAY_SLACK) return { avisado: false, motivo: 'sin SLACK_BOT_TOKEN' };

  const partes = [
    `🚨 *${agente} se cayo*`,
    `\`\`\`${corta(mensaje, 900)}\`\`\``,
    pista ? `_${pista}_` : null,
  ].filter(Boolean);

  const cuerpo = {
    text: `🚨 ${agente} se cayo: ${corta(mensaje, 120)}`,
    blocks: partes.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: corta(t, 2900) } })),
    unfurl_links: false,
  };

  for (const canal of CANALES) {
    try {
      await postear({ channel: canal, username: 'Alertas SC', icon_emoji: ':rotating_light:', ...cuerpo });
      return { avisado: true, canal };
    } catch (e) {
      if (/not_allowed_token_type|invalid_arguments/.test(e.message)) {
        try {
          await postear({ channel: canal, ...cuerpo });
          return { avisado: true, canal };
        } catch { /* se prueba el canal siguiente */ }
      }
      if (!/not_in_channel|channel_not_found|is_archived/.test(e.message)) break;
    }
  }
  return { avisado: false, motivo: 'ningun canal acepto el aviso' };
}

/**
 * Lo que hizo una corrida, para las que hacen algo hacia afuera.
 *
 * No es un aviso de error: es visibilidad. Existe porque los logs de algunas
 * funciones no llegan al panel de Netlify, y un agente que manda mensajes sin
 * dejar constancia es un agente que nadie puede auditar.
 */
export async function avisarResumen(agente, resumen, detalle = []) {
  if (!HAY_SLACK) return { avisado: false, motivo: 'sin SLACK_BOT_TOKEN' };
  const lineas = (detalle || []).filter(Boolean).slice(0, 12).join(String.fromCharCode(10));
  const partes = [`🌙 *${agente}*`, `\`${corta(resumen, 300)}\``, lineas ? `\`\`\`${corta(lineas, 1500)}\`\`\`` : null]
    .filter(Boolean);

  const cuerpo = {
    text: `${agente}: ${corta(resumen, 120)}`,
    blocks: partes.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: corta(t, 2900) } })),
    unfurl_links: false,
  };

  for (const canal of CANALES) {
    try {
      await postear({ channel: canal, username: 'Alertas SC', icon_emoji: ':crescent_moon:', ...cuerpo });
      return { avisado: true, canal };
    } catch (e) {
      if (/not_allowed_token_type|invalid_arguments/.test(e.message)) {
        try { await postear({ channel: canal, ...cuerpo }); return { avisado: true, canal }; } catch {}
      }
      if (!/not_in_channel|channel_not_found|is_archived/.test(e.message)) break;
    }
  }
  return { avisado: false, motivo: 'ningun canal acepto el aviso' };
}
