// Aviso interno. Nunca le escribe al cliente: esto va a un canal del equipo.
import {
  HAY_SLACK,
  ZOHO_UI,
  EQUIPOS,
  RUTEO,
  COPIA_CX_EN_RIESGO,
  nombrar,
  webhookDe,
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

export async function enviar(alerta) {
  const salidas = [];
  for (const equipo of destinos(alerta)) {
    const cuerpo = armarMensaje(alerta, equipo);
    const url = webhookDe(equipo.clave);
    if (!url) {
      salidas.push({ equipo: equipo.clave, enviado: false, motivo: 'sin webhook (modo sombra)', cuerpo });
      continue;
    }
    await postear(url, cuerpo);
    salidas.push({ equipo: equipo.clave, enviado: true, cuerpo });
  }
  return salidas;
}

/**
 * Aviso de una venta que quedó abierta. Es distinto de las otras alertas: acá
 * el equipo YA contestó, y el problema es que la cosa quedó ahí.
 */
export async function avisarVentaAbierta(v) {
  const equipo = EQUIPOS[RUTEO[v.tema]?.[0] || 'ventas'];
  const quienes = (equipo.personas || []).map(nombrar).join(' ');
  const link = v.ficha ? linkZoho({ modulo: v.ficha.modulo, id: v.ficha.id }) : null;
  const cita = (t, n) => String(t).slice(0, n).split('\n').join('\n> ');

  const partes = [
    `💰 *Venta sin cerrar hace ${v.diasAbierta} días* · ${quienes}\n${v.quien}: ${v.resumen}`,
    `*Pidió:*\n> ${cita(v.mensaje, 300)}`,
  ];

  if (v.ultimoMensajeDeLaCharla) {
    const quien = v.quienContestoUltimo ? `*Último, de ${v.quienContestoUltimo}:*` : '*Último en la charla:*';
    partes.push(`${quien}\n> ${cita(v.ultimoMensajeDeLaCharla, 250)}`);
  }

  partes.push(
    '_No hay trato abierto ni movimiento en el CRM. Va a seguir apareciendo hasta que se cierre._' +
      (link ? ` <${link}|Abrir en Zoho>` : '')
  );

  const cuerpo = {
    text: `💰 Venta sin cerrar hace ${v.diasAbierta} días: ${v.quien}`,
    blocks: partes.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
  };

  const url = webhookDe(RUTEO[v.tema]?.[0] || 'ventas');
  if (!url) return { enviado: false, cuerpo };
  await postear(url, cuerpo);
  return { enviado: true, cuerpo };
}

/** Cuando el CRM muestra que la venta se movió, se avisa y se deja de insistir. */
export async function avisarVentaCerrada(v) {
  const url = webhookDe(RUTEO[v.tema]?.[0] || 'ventas');
  const texto = `✅ *${v.quien}* — dejo de insistir: ${v.motivoCierre}.`;
  if (!url) return { enviado: false, texto };
  await postear(url, { text: texto, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: texto } }] });
  return { enviado: true, texto };
}

/** Aviso único cuando la corrida topeó el máximo de alertas. */
export async function enviarResumenTope(cuantas, tope) {
  const texto = `⚠️ Hay ${cuantas} conversaciones pendientes en esta pasada y el tope por corrida es ${tope}. Se avisaron las ${tope} más urgentes. Conviene revisar la bandeja de WhatsApp en Zoho a mano.`;
  if (!HAY_SLACK) return { enviado: false, texto };
  const urls = [...new Set(['ventas', 'cx', 'admin'].map(webhookDe).filter(Boolean))];
  for (const u of urls) await postear(u, { text: texto });
  return { enviado: true, texto };
}
