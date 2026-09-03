// Que pasa cuando el vendedor toca "Aprobar" en Slack.
//
// La usa tanto la funcion de Netlify (el boton) como el CLI, para que el
// comportamiento sea uno solo y no dos que se parecen.
//
// LO QUE ESCRIBE: una nota y una tarea. Las dos son registros nuevos.
// LO QUE NO TOCA, A PROPOSITO:
//   - No edita el lead. Editar un lead en este CRM dispara envios al cliente
//     (agosto 2026: una regla en bucle mando la misma plantilla cada 3 minutos
//     hasta que Meta bloqueo el numero).
//   - No prende `Retargeting`. La cadencia hoy entra por el mensaje 2 y el 76%
//     se congela en el 3; meter gente ahi automaticamente es empeorarlo. El
//     coach recomienda, la persona decide.
import { env } from './entorno.js';

const API = 'https://www.zohoapis.com/crm/v6';

let cache = null;
export async function tokenZoho() {
  if (cache && Date.now() < cache.exp) return cache.v;
  const p = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const j = await (await fetch(`https://accounts.zoho.com/oauth/v2/token?${p}`, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho no devolvio token');
  cache = { v: j.access_token, exp: Date.now() + 55 * 60 * 1000 };
  return j.access_token;
}

async function zoho(path, opciones = {}, token) {
  const t = token || (await tokenZoho());
  const r = await fetch(`${API}/${path}`, {
    ...opciones,
    headers: {
      Authorization: `Zoho-oauthtoken ${t}`,
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (r.status === 204) return {};
  const j = await r.json();
  if (j.status === 'error') throw new Error(`${path}: ${j.code} ${j.message}`);
  return j;
}

const ETIQUETA_VIA = {
  seguimiento_vendedor: 'seguimiento del vendedor',
  retargeting_30d: 'retargeting 30 dias',
  nurturing: 'nurturing',
  ninguno: 'sin seguimiento',
};

function fechaEn(dias) {
  const d = new Date();
  d.setDate(d.getDate() + Math.max(0, Number(dias) || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Registra en Zoho el mensaje aprobado y el seguimiento.
 *
 * @param {object} caso    lo guardado por el coach
 * @param {string} texto   el mensaje final (puede venir editado desde el modal)
 * @param {string} quien   nombre de quien aprobo en Slack
 * @returns {Promise<{notaId: string, tareaId: string|null}>}
 */
export async function registrarAprobacion({ caso, texto, quien }) {
  const t = await tokenZoho();
  const s = caso.coach?.seguimiento || {};
  const leadId = caso.lead?.id;
  if (!leadId) throw new Error('el caso no tiene lead de Zoho');

  // --- 1. La nota con el mensaje aprobado -------------------------------
  const cuerpoNota = [
    `Mensaje post-llamada aprobado${quien ? ` por ${quien}` : ''} el ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.`,
    caso.ventana?.abierta === true
      ? `Ventana de WhatsApp abierta (quedaban ${caso.ventana.horasRestantes}h): se puede mandar como texto libre.`
      : 'Ventana de WhatsApp cerrada: hay que mandarlo por mail o con plantilla aprobada.',
    '',
    'TEXTO:',
    texto,
    '',
    `Seguimiento decidido: ${ETIQUETA_VIA[s.via] || s.via || '?'} · ${s.cuando || ''}`,
    s.motivo ? `Motivo: ${s.motivo}` : null,
    s.que_decir ? `Angulo del proximo contacto: ${s.que_decir}` : null,
    caso.llamada?.url ? `\nGrabacion: ${caso.llamada.url}` : null,
  ]
    .filter((x) => x !== null)
    .join('\n');

  const pedirNota = zoho(
    'Notes',
    {
      method: 'POST',
      body: JSON.stringify({
        data: [
          {
            Note_Title: 'Mensaje post-llamada aprobado',
            Note_Content: cuerpoNota.slice(0, 32000),
            Parent_Id: { module: { api_name: 'Leads' }, id: leadId },
          },
        ],
      }),
    },
    t
  );

  // --- 2. La tarea de seguimiento ---------------------------------------
  // Solo si hay algo que hacer. "ninguno" no genera tarea: una tarea que nadie
  // va a hacer es ruido, y el equipo ya tiene 2.930 cadencias vencidas.
  //
  // Va EN PARALELO con la nota, no despues: son independientes y Slack corta
  // el boton a los 3 segundos. En serie, medido contra el CRM real, daba 2,97s
  // y no entraba con el chat.update encima.
  let pedirTarea = null;
  if (s.via && s.via !== 'ninguno') {
    const tarea = {
      Subject: `Seguimiento: ${(caso.lead?.Full_Name || 'cliente').slice(0, 80)}`,
      Status: 'Not Started',
      Priority: s.dias <= 0 ? 'High' : 'Normal',
      Due_Date: fechaEn(s.dias),
      What_Id: leadId,
      $se_module: 'Leads',
      Description: [
        `Via: ${ETIQUETA_VIA[s.via] || s.via}`,
        s.motivo ? `Motivo: ${s.motivo}` : null,
        s.que_decir ? `Angulo: ${s.que_decir}` : null,
        // El plan va con fecha absoluta: la tarea se lee semanas despues y
        // "en 3 dias" ahi no significa nada.
        ...(s.plan?.length
          ? ['', 'Plan de seguimiento:', ...s.plan.map((p, i) => `  ${i + 1}. ${fechaEn(p.dias)} · ${p.canal} · ${p.que_hacer}`)]
          : []),
        s.si_no_contesta ? `\nSi no contesta: ${s.si_no_contesta}` : null,
        '',
        'Mensaje aprobado:',
        texto,
      ]
        .filter((x) => x !== null)
        .join('\n')
        .slice(0, 32000),
    };
    // El dueño del lead es quien tiene que hacerlo. Si no se sabe, queda sin
    // asignar antes que asignarselo a la persona equivocada.
    if (caso.lead?.Owner?.id) tarea.Owner = caso.lead.Owner.id;
    pedirTarea = zoho('Tasks', { method: 'POST', body: JSON.stringify({ data: [tarea] }) }, t);
  }

  const [jn, jt] = await Promise.all([pedirNota, pedirTarea]);

  const rn = (jn.data || [])[0];
  if (rn?.code !== 'SUCCESS') throw new Error(`nota: ${rn?.code} ${rn?.message}`);

  let tareaId = null;
  if (jt) {
    const rt = (jt.data || [])[0];
    if (rt?.code !== 'SUCCESS') throw new Error(`tarea: ${rt?.code} ${rt?.message}`);
    tareaId = rt.details?.id || null;
  }

  return { notaId: rn.details?.id, tareaId };
}

/** Deja constancia de que se descarto, sin ensuciar el CRM. */
export async function registrarDescarte({ caso, quien }) {
  return { registrado: false, motivo: 'los descartes no se escriben en Zoho' };
}
