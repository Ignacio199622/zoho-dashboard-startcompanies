// Aviso interno. Nunca le escribe al cliente: esto va a un canal del equipo.
import {
  HAY_SLACK,
  ZOHO_UI,
  EQUIPOS,
  RUTEO,
  COPIA_CX_EN_RIESGO,
  nombrar,
  webhookDe,
  CANAL_POR_EQUIPO,
  SLACK_BOT_TOKEN,
} from './config.js';
import { CATEGORIAS, TEMAS } from './clasificar.js';

const MODULO_TAB = { Contacts: 'Contacts', Leads: 'Leads' };

export function linkZoho(ficha) {
  const tab = MODULO_TAB[ficha?.modulo];
  return tab && ficha?.id ? `${ZOHO_UI}/${tab}/${ficha.id}` : null;
}

/** A quién le toca, según el tema. El primero atiende, los demás van en copia. */
export function equipoDe(alerta) {
  const claves = RUTEO[alerta.clase?.tema] || ['cx'];
  return { clave: claves[0], ...EQUIPOS[claves[0]] };
}

/**
 * Los canales a los que va esta alerta. Además de las copias que define el
 * ruteo, un cliente enojado es un problema de retención aunque el tema sea de
 * otro equipo: en ese caso CX recibe copia si no era ya su canal.
 */
export function destinos(alerta) {
  const claves = [...(RUTEO[alerta.clase?.tema] || ['cx'])];
  if (COPIA_CX_EN_RIESGO && alerta.clase?.categoria === 'riesgo' && !claves.includes('cx')) {
    claves.push('cx');
  }
  return claves.map((clave, i) => ({ clave, ...EQUIPOS[clave], esCopia: i > 0 }));
}

export function armarMensaje(a, equipo) {
  const cat = CATEGORIAS[a.clase?.categoria] || CATEGORIAS.operativo;
  const nombre = a.ficha?.Full_Name || a.mobile_number__s || 'Sin nombre';
  const link = linkZoho(a.ficha);
  const tipo = a.ficha?.modulo === 'Contacts' ? 'Cliente' : 'Lead';

  const ventana = a.ventanaCerrada
    ? '⛔ ventana de 24h cerrada, solo plantilla'
    : `⏳ ${a.horasDeVentana}h de ventana`;

  const quienes = (equipo.personas || []).map(nombrar).join(' ');
  const tema = TEMAS[a.clase?.tema] || '';
  // Un recordatorio se ve distinto a proposito: si llega igual que el primer
  // aviso, en el canal parece un duplicado y se ignora.
  const insiste = a.seguimiento?.accion === 'recordar';
  const prefijo = insiste
    ? `🔁 *Recordatorio ${a.seguimiento.numero}* · sigue sin respuesta hace ${a.seguimiento.horasDesdePrimero}h
`
    : '';
  const encabezado = equipo.esCopia
    ? `${prefijo}${cat.emoji} *${cat.etiqueta} · ${tema}* · en copia: ${quienes}`
    : `${prefijo}${cat.emoji} *${cat.etiqueta} · ${tema}* · ${quienes}`;

  const bloques = [
    { type: 'section', text: { type: 'mrkdwn', text: `${encabezado}\n${a.clase?.resumen || ''}` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${tipo}:* ${nombre}   *Espera:* ${a.horasEsperando}h · ${ventana}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `> ${String(a.last_message__s || '').slice(0, 500).replace(/\n/g, '\n> ')}` },
    },
  ];

  if (a.clase?.accion) {
    bloques.push({ type: 'section', text: { type: 'mrkdwn', text: `*Sugerido:* ${a.clase.accion}` } });
  }
  // El borrador va en bloque de codigo: en Slack se copia de un toque y no se
  // come el formato. Es un punto de partida para editar, no para mandar a ciegas.
  if (a.clase?.borrador) {
    bloques.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Respuesta sugerida* (revisala antes de mandar)
\`\`\`${a.clase.borrador}\`\`\`` },
    });
  }
  bloques.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          (a.decision.motivos || []).join(' · ') +
          (link ? ` · <${link}|abrir en Zoho>` : ''),
      },
    ],
  });

  return {
    text: `${insiste ? `Recordatorio ${a.seguimiento.numero}: ` : ''}${cat.emoji} ${cat.etiqueta} · ${nombre}: ${a.clase?.resumen || ''}`,
    blocks: bloques,
  };
}

async function postear(url, cuerpo) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Slack HTTP ${r.status}: ${txt.slice(0, 200)}`);
}

/**
 * Publica en el canal del equipo con el bot. Si no hay bot token o el canal no
 * acepta (el bot no esta invitado), cae al webhook de siempre: un aviso en el
 * canal equivocado es mejor que un aviso perdido.
 * Devuelve false si no hay a donde mandarlo (modo sombra).
 */
async function postearEquipo(clave, cuerpo) {
  const canal = CANAL_POR_EQUIPO[clave];
  if (SLACK_BOT_TOKEN && canal) {
    try {
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel: canal, unfurl_links: false, ...cuerpo }),
      });
      const j = await r.json();
      if (j.ok) return true;
      console.error(`Slack ${canal}: ${j.error}, va por webhook`);
    } catch (e) {
      console.error(`Slack ${canal}: ${e.message}, va por webhook`);
    }
  }
  const url = webhookDe(clave);
  if (!url) return false;
  await postear(url, cuerpo);
  return true;
}

export async function enviar(alerta) {
  const salidas = [];
  for (const equipo of destinos(alerta)) {
    const cuerpo = armarMensaje(alerta, equipo);
    if (!(await postearEquipo(equipo.clave, cuerpo))) {
      salidas.push({ equipo: equipo.clave, enviado: false, motivo: 'sin webhook (modo sombra)', cuerpo });
      continue;
    }
    salidas.push({ equipo: equipo.clave, enviado: true, cuerpo });
  }
  return salidas;
}

/**
 * Ventas abiertas: UN mensaje por dia y por equipo, con la lista entera.
 * Antes salia un mensaje por lead cada vez que vencia el plazo (345 por semana
 * en #alertas-mensajes) y nadie los leia. Ahora sale a las 9:00 en #ventas:
 * las que siguen sin cerrar, con los dias, el link a Zoho y lo ultimo de la
 * charla, y las que se movieron en el CRM y dejan de aparecer.
 */
export async function avisarResumenVentas(aInsistir = [], cerradas = []) {
  if (!aInsistir.length && !cerradas.length) return { enviado: false };
  const porEquipo = {};
  const clave = (v) => RUTEO[v.tema]?.[0] || 'ventas';
  for (const v of aInsistir) (porEquipo[clave(v)] ||= { abiertas: [], cerradas: [] }).abiertas.push(v);
  for (const v of cerradas) (porEquipo[clave(v)] ||= { abiertas: [], cerradas: [] }).cerradas.push(v);

  const salidas = [];
  for (const [k, g] of Object.entries(porEquipo)) {
    const equipo = EQUIPOS[k] || EQUIPOS.ventas;
    const quienes = (equipo.personas || []).map(nombrar).join(' ');
    const linea = (v) => {
      const link = v.ficha ? linkZoho({ modulo: v.ficha.modulo, id: v.ficha.id }) : null;
      const nombre = link ? `<${link}|${v.quien}>` : `*${v.quien}*`;
      const ultimo = v.ultimoMensajeDeLaCharla
        ? ` · _último${v.quienContestoUltimo ? ` de ${v.quienContestoUltimo}` : ''}: "${String(v.ultimoMensajeDeLaCharla).slice(0, 90).replace(/\n/g, ' ')}"_`
        : '';
      return `• ${nombre} · ${v.diasAbierta} días · ${String(v.resumen || '').slice(0, 120)}${ultimo}`;
    };
    const titulo = k === 'admin' ? 'Renovaciones sin cerrar hoy' : 'Ventas sin cerrar hoy';
    const abiertas = [...g.abiertas].sort((a, b) => b.diasAbierta - a.diasAbierta);
    const partes = [
      `💰 *${titulo}: ${abiertas.length}* · ${quienes}
_Sin trato abierto ni movimiento en el CRM. Cada una sigue apareciendo acá hasta que se cierre en Zoho._`,
    ];
    // Slack corta un bloque en 3.000 caracteres: de a 12 lineas por bloque.
    for (let i = 0; i < abiertas.length && i < 60; i += 12) {
      partes.push(abiertas.slice(i, i + 12).map(linea).join('\n'));
    }
    if (abiertas.length > 60) partes.push(`_…y ${abiertas.length - 60} más._`);
    if (g.cerradas.length) {
      partes.push(
        '*Se movieron y salen de la lista:*\n' +
          g.cerradas.slice(0, 20).map((v) => `✅ *${v.quien}*: ${v.motivoCierre}`).join('\n')
      );
    }
    const cuerpo = {
      text: `💰 ${titulo}: ${abiertas.length}`,
      blocks: partes.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t.slice(0, 2900) } })),
    };
    salidas.push({ equipo: k, enviado: await postearEquipo(k, cuerpo), cuerpo });
  }
  return salidas;
}

/** Aviso único cuando la corrida topeó el máximo de alertas. */
export async function enviarResumenTope(cuantas, tope) {
  const texto = `⚠️ Hay ${cuantas} conversaciones pendientes en esta pasada y el tope por corrida es ${tope}. Se avisaron las ${tope} más urgentes. Conviene revisar la bandeja de WhatsApp en Zoho a mano.`;
  if (!HAY_SLACK) return { enviado: false, texto };
  for (const k of ['ventas', 'cx']) await postearEquipo(k, { text: texto });
  return { enviado: true, texto };
}
