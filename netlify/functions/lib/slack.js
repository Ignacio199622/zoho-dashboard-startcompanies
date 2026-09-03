// La tarjeta del Coach de Ventas en Slack, con los botones de aprobacion.
//
// Va con bot token (`chat.postMessage`), no con webhook entrante: los webhooks
// no pueden actualizar un mensaje ya publicado, y toda la gracia de los botones
// es que la tarjeta se reescriba sola cuando el vendedor aprueba.
import { env } from './entorno.js';
import { PASOS } from './coach.js';
import { etiquetaVentana } from './ventana.js';
import { linkWhatsApp } from './telefono.js';

export const CANAL = env.SLACK_CANAL || '#calls-startcompanies';
export const HAY_SLACK = Boolean(env.SLACK_BOT_TOKEN);
export const ZOHO_UI = 'https://crm.zoho.com/crm/org878580932/tab';

const ICONO = { si: '✅', parcial: '⚠️', no: '❌', no_aplica: '➖' };

const VIA = {
  seguimiento_vendedor: { emoji: '👤', texto: 'Seguimiento del vendedor (a mano)' },
  retargeting_30d: { emoji: '🔁', texto: 'Retargeting 30 días (cadencia del CRM)' },
  nurturing: { emoji: '🌱', texto: 'Nurturing (mail cada 45 días)' },
  ninguno: { emoji: '⏹️', texto: 'No hace falta seguimiento' },
};

const CANAL_EMOJI = { whatsapp: '💬', llamada: '📞', mail: '📧', audio: '🎙️' };

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * "en 3 días" obliga a hacer la cuenta y se lee distinto segun cuando abras la
 * tarjeta. Un dia de la semana con fecha no se malinterpreta.
 */
export function cuandoTexto(dias, hoy = new Date()) {
  const d = Number(dias) || 0;
  if (d <= 0) return 'hoy';
  if (d === 1) return 'mañana';
  const f = new Date(hoy);
  f.setDate(f.getDate() + d);
  const dia = `${DIAS_SEMANA[f.getDay()]} ${f.getDate()}/${f.getMonth() + 1}`;
  return d <= 7 ? dia : `${dia} (en ${d} días)`;
}

const corta = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const seccion = (texto) => ({ type: 'section', text: { type: 'mrkdwn', text: corta(texto, 2900) } });

/**
 * La tarjeta completa. `caso` es lo que guarda el almacen: trae la llamada, el
 * analisis, el informe del coach, el lead y el estado de la ventana.
 */
export function armarTarjeta(caso, { estado = 'pendiente', quien = null } = {}) {
  const { coach, analisis, llamada, lead, ventana } = caso;
  const b = [];

  // --- Cabecera ---------------------------------------------------------
  const nombre = lead?.Full_Name || analisis?.cliente || 'Cliente sin identificar';
  b.push({
    type: 'header',
    text: { type: 'plain_text', text: `📞 ${corta(nombre, 100)}`, emoji: true },
  });

  // El vendedor sale como la persona de Zoho, no como el nombre suelto que
  // dijo la transcripcion. Fathom no ayuda: todas las llamadas se graban con
  // una cuenta generica, y el dueno del lead es "Start Companies Staff" en el
  // 68% de los casos. El unico origen es lo que se dijo en la llamada.
  const v = caso.vendedor || {};
  const vendedorTexto = v.id
    ? v.nombre
    : v.detectado
      ? `${v.detectado} ⚠️ ${v.motivo}`
      : 'no identificado';

  const meta = [
    `*Vendedor:* ${vendedorTexto}`,
    `*Resultado:* ${(analisis?.resultado || '?').replace(/_/g, ' ')}`,
    `*Interés:* ${analisis?.nivel_de_interes || '?'}`,
    llamada?.minutos ? `*Duración:* ${llamada.minutos} min` : null,
  ].filter(Boolean);
  b.push(seccion(meta.join('   ·   ')));

  const links = [
    llamada?.url ? `<${llamada.url}|ver la grabación>` : null,
    lead?.id ? `<${ZOHO_UI}/${lead.modulo || 'Leads'}/${lead.id}|abrir en Zoho${lead.modulo === 'Contacts' ? ' (ya es cliente)' : ''}>` : null,
  ].filter(Boolean);
  if (links.length) b.push({ type: 'context', elements: [{ type: 'mrkdwn', text: links.join(' · ') }] });

  if (analisis?.cliente_se_presento === false) {
    b.push(seccion('🚫 *El cliente no se presentó.* La grabación es el vendedor esperando solo.'));
  }

  // --- El script --------------------------------------------------------
  b.push({ type: 'divider' });
  b.push(seccion('*📋 ¿Siguió el script?*'));
  const filas = PASOS.map(([clave, etiqueta]) => {
    const p = coach.script?.[clave] || {};
    const cita = p.cita ? `\n       _"${corta(p.cita, 160)}"_` : '';
    return `${ICONO[p.estado] || '➖'} *${etiqueta}* · ${corta(p.comentario, 200)}${cita}`;
  });
  // Slack corta las secciones en 3000 caracteres: van de a dos para no perder nada.
  for (let i = 0; i < filas.length; i += 2) b.push(seccion(filas.slice(i, i + 2).join('\n')));

  if (coach.fuertes?.length) {
    b.push(seccion('*✅ Lo que hizo bien*\n' + coach.fuertes.map((x) => `→ ${x}`).join('\n')));
  }
  if (coach.a_mejorar?.length) {
    b.push(seccion('*🔧 Para la próxima*\n' + coach.a_mejorar.map((x) => `→ ${x}`).join('\n')));
  }
  if (coach.momento_clave) b.push(seccion(`*🎯 Momento clave*\n${coach.momento_clave}`));

  // --- Seguimiento ------------------------------------------------------
  b.push({ type: 'divider' });
  const via = VIA[coach.seguimiento?.via] || VIA.ninguno;
  b.push(
    seccion(
      `*${v.emoji} Seguimiento sugerido: ${v.texto}*\n` +
        `*Por qué:* ${coach.seguimiento?.motivo || ''}` +
        (coach.seguimiento?.que_decir ? `\n*Ángulo:* ${coach.seguimiento.que_decir}` : '')
    )
  );

  // El COMO: los toques concretos, con fecha real en vez de "en 3 dias".
  const plan = coach.seguimiento?.plan || [];
  if (plan.length) {
    const pasos = plan.map((p, i) => `${i + 1}. *${cuandoTexto(p.dias)}* · ${CANAL_EMOJI[p.canal] || ''} ${p.canal} · ${p.que_hacer}`);
    b.push(seccion('*Cómo hacerlo*\n' + pasos.join('\n')));
  }
  if (coach.seguimiento?.si_no_contesta) {
    b.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🚪 *Si no contesta:* ${coach.seguimiento.si_no_contesta}` }],
    });
  }
  if (coach.seguimiento?.via === 'retargeting_30d') {
    b.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '⚠️ El agente *no* prende el flag de Retargeting: la cadencia hoy entra por el mensaje 2 y se congela en el 3. Lo prende una persona.',
        },
      ],
    });
  }

  // --- El mensaje -------------------------------------------------------
  if (coach.mensaje?.texto) {
    // Si el vendedor lo edito en el modal, manda su version.
    const texto = caso.textoFinal || coach.mensaje.texto;
    b.push({ type: 'divider' });
    b.push(seccion(`*✍️ Mensaje post-llamada*   ${etiquetaVentana(ventana)}`));
    b.push(seccion('> ' + texto.replace(/\n/g, '\n> ')));
    b.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${coach.mensaje.por_que}_ · mandarlo *${coach.mensaje.urgencia}*` }],
    });

    if (estado === 'pendiente') {
      b.push({
        type: 'actions',
        block_id: `coach:${caso.id}`,
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: '✅ Aprobar y enviar', emoji: true },
            action_id: 'coach_aprobar',
            value: caso.id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Editar', emoji: true },
            action_id: 'coach_editar',
            value: caso.id,
          },
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: '✖️ Descartar', emoji: true },
            action_id: 'coach_descartar',
            value: caso.id,
          },
        ],
      });
    } else if (estado === 'aprobado') {
      // Zoho no expone forma de mandar el WhatsApp por API: el modulo de
      // mensajes es de solo lectura (`creatable: false`, verificado el
      // 2026-09-03). Asi que el agente deja el mensaje a un toque de distancia
      // y el envio lo hace la persona. Se ofrecen los dos caminos porque no dan
      // lo mismo: por Zoho sale desde el numero de la empresa y queda en el
      // hilo del cliente; por wa.me sale desde el telefono del vendedor.
      const link = linkWhatsApp(caso.telefono, texto);
      const enZoho = lead?.id ? `<${ZOHO_UI}/${lead.modulo || 'Leads'}/${lead.id}|💬 Mandarlo desde Zoho (número de la empresa)>` : null;
      const w = caso.zoho?.vendedor;
      const lineaVendedor = w?.escrito
        ? ` y quedó ${w.nombre} como vendedor.`
        : w?.motivo
          ? ` El vendedor no se cargó: ${w.motivo}.`
          : '';
      b.push(
        seccion(
          `*✅ Aprobado${quien ? ` por <@${quien}>` : ''}* · quedó la nota y la tarea de seguimiento en Zoho${lineaVendedor}\n\n` +
            [enZoho, link ? `<${link}|📲 Abrirlo en tu WhatsApp con el texto ya escrito>` : null]
              .filter(Boolean)
              .join('\n') || '_El lead no tiene teléfono cargado._'
        )
      );
      if (w?.alerta) b.push(seccion(w.alerta));
    } else if (estado === 'descartado') {
      b.push(seccion(`*✖️ Descartado${quien ? ` por <@${quien}>` : ''}.* No se escribió nada en Zoho.`));
    }
  } else {
    b.push({ type: 'divider' });
    b.push(seccion('*✍️ Mensaje post-llamada:* no corresponde mandar nada en esta llamada.'));
  }

  const resumen = `${nombre} · ${(analisis?.resultado || '').replace(/_/g, ' ')} · ${via.texto}`;
  return { text: `📞 Coach de Ventas: ${corta(resumen, 150)}`, blocks: b };
}

/** La misma tarjeta en texto plano, para ver en la terminal lo que iria a Slack. */
export function tarjetaEnTexto(caso, opciones) {
  const { blocks } = armarTarjeta(caso, opciones);
  return blocks
    .map((b) => {
      if (b.type === 'divider') return '─'.repeat(66);
      if (b.type === 'header') return `\n${b.text.text}`;
      if (b.type === 'actions') return `[ ${b.elements.map((e) => e.text.text).join(' ]  [ ')} ]`;
      return b.text?.text || (b.elements || []).map((e) => e.text || '').join(' ');
    })
    .join('\n')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2: $1');
}

// ─── API de Slack ──────────────────────────────────────────────────────────

export async function api(metodo, cuerpo, token = env.SLACK_BOT_TOKEN) {
  const r = await fetch(`https://slack.com/api/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${metodo}: ${j.error}`);
  return j;
}

// La app de Slack es compartida y se llama "Avisos SC - ALERTAS", porque en
// este workspace no se pueden crear apps nuevas. Con estos dos campos las
// tarjetas salen firmadas como el Coach igual. Necesita el scope
// `chat:write.customize`; sin el, Slack devuelve `not_allowed_token_type` y el
// codigo reintenta sin firmar, que es peor nombre pero funciona.
const FIRMA = { username: 'Coach de Ventas SC', icon_emoji: ':telephone_receiver:' };

/** Publica la tarjeta. Sin bot token no manda nada: queda en modo sombra. */
export async function publicar(caso) {
  const cuerpo = armarTarjeta(caso);
  if (!HAY_SLACK) return { enviado: false, motivo: 'sin SLACK_BOT_TOKEN (modo sombra)', cuerpo };

  let j;
  try {
    j = await api('chat.postMessage', { channel: CANAL, ...FIRMA, ...cuerpo, unfurl_links: false });
  } catch (e) {
    if (!/not_allowed_token_type|invalid_arguments/.test(e.message)) throw e;
    j = await api('chat.postMessage', { channel: CANAL, ...cuerpo, unfurl_links: false });
  }
  return { enviado: true, ts: j.ts, canal: j.channel, cuerpo };
}

/** Reescribe una tarjeta ya publicada (lo que pasa al aprobar o descartar). */
export async function actualizar({ canal, ts, caso, estado, quien }, token) {
  const cuerpo = armarTarjeta(caso, { estado, quien });
  return api('chat.update', { channel: canal, ts, ...cuerpo }, token);
}

/** El modal de edicion del mensaje. */
export function modalEdicion(caso) {
  return {
    type: 'modal',
    callback_id: 'coach_editar_submit',
    private_metadata: caso.id,
    title: { type: 'plain_text', text: 'Editar el mensaje' },
    submit: { type: 'plain_text', text: 'Aprobar y enviar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'input',
        block_id: 'texto',
        label: { type: 'plain_text', text: `Mensaje para ${corta(caso.lead?.Full_Name || 'el cliente', 60)}` },
        element: {
          type: 'plain_text_input',
          action_id: 'valor',
          multiline: true,
          initial_value: caso.coach?.mensaje?.texto || '',
        },
      },
    ],
  };
}
