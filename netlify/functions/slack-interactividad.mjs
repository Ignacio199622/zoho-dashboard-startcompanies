/*
 * EL endpoint de interactividad de Slack. Uno solo para todos los agentes.
 *
 * Slack pega aca cuando alguien toca un boton en cualquier tarjeta que
 * publiquemos. Hoy el unico que tiene botones es el Coach de Ventas
 * ("Aprobar", "Editar", "Descartar"), y esta es la unica parte del sistema que
 * escribe en Zoho: solo escribe cuando una persona lo pidio.
 *
 * En la app de Slack va como "Interactivity & Shortcuts → Request URL":
 *   https://metricastart.netlify.app/.netlify/functions/slack-interactividad
 *
 * POR QUE ES UNO SOLO Y NO UNO POR AGENTE:
 * Slack admite UNA sola Request URL por app, y en este workspace no se pueden
 * crear apps nuevas: todos los agentes comparten "Avisos SC - ALERTAS". Asi que
 * el ruteo es nuestro, por prefijo del `action_id`.
 *
 * PARA AGREGAR OTRO AGENTE (ej: botones en los avisos de WhatsApp):
 *   1. que sus `action_id` arranquen con su prefijo, ej `wa_atendido`
 *   2. agregar el prefijo a MANEJADORES, abajo
 * No hay que tocar ni la app de Slack ni la URL.
 *
 * TRES COSAS QUE HAY QUE SABER SI SE TOCA ESTO:
 *
 * 1. Slack corta a los 3 segundos. Por eso la nota y la tarea de Zoho se piden
 *    en paralelo y no se relee nada para confirmar: en serie, medido contra el
 *    CRM real, eran 2,97s y no entraba el chat.update encima.
 *
 * 2. La firma se calcula sobre el cuerpo CRUDO. Hay que leerlo con req.text()
 *    antes de parsear nada; si se parsea y se vuelve a serializar, la firma no
 *    da y todo devuelve 401 sin explicacion.
 *
 * 3. Nunca edita el lead. Editar un lead en este CRM dispara envios al cliente
 *    (agosto 2026, la regla en bucle que hizo que Meta bloqueara el numero).
 *    Notas y tareas son registros nuevos y no disparan reglas del modulo Leads.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { obtener, actualizar } from './lib/casos.js';
import { registrarAprobacion } from './lib/aprobacion.js';
import { armarTarjeta, modalEdicion, api as slack } from './lib/slack.js';
import { env } from './lib/entorno.js';

const VENTANA_FIRMA = 5 * 60; // segundos, lo que recomienda Slack

// Que agente atiende cada boton, por prefijo del action_id. Ver la cabecera.
const MANEJADORES = { coach_: manejarCoach };

function manejadorPara(actionId = '') {
  const par = Object.entries(MANEJADORES).find(([prefijo]) => actionId.startsWith(prefijo));
  return par ? par[1] : null;
}

function firmaValida(cuerpo, ts, firma) {
  const secreto = env.SLACK_SIGNING_SECRET;
  if (!secreto || !ts || !firma) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > VENTANA_FIRMA) return false;
  const esperada = 'v0=' + createHmac('sha256', secreto).update(`v0:${ts}:${cuerpo}`).digest('hex');
  const a = Buffer.from(esperada);
  const b = Buffer.from(firma);
  return a.length === b.length && timingSafeEqual(a, b);
}

const ok = (cuerpo = '') =>
  new Response(cuerpo, { status: 200, headers: { 'Content-Type': 'application/json' } });

const efimero = (texto) =>
  ok(JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: texto }));

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const crudo = await req.text();

  // Al guardar la Request URL, Slack manda un `ssl_check=1` y espera un 200.
  // Se contesta ANTES de validar la firma a proposito: si no, no se puede
  // guardar la URL hasta tener el SLACK_SIGNING_SECRET cargado, y el secreto
  // esta en la misma pantalla que la URL. No abre ningun agujero: el ssl_check
  // no trae datos y no dispara ninguna accion.
  if (new URLSearchParams(crudo).get('ssl_check')) return ok();

  if (!firmaValida(crudo, req.headers.get('x-slack-request-timestamp'), req.headers.get('x-slack-signature'))) {
    return new Response('firma invalida', { status: 401 });
  }

  const payload = JSON.parse(new URLSearchParams(crudo).get('payload') || '{}');

  try {
    if (payload.type === 'block_actions') {
      const accion = payload.actions?.[0] || {};
      const manejador = manejadorPara(accion.action_id);
      // Un boton de otro agente que todavia no esta cableado: 200 y silencio,
      // mejor que un error rojo en la cara del que lo toco.
      if (!manejador) return ok();
      return await manejador(payload, accion);
    }

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'coach_editar_submit') {
      return await manejarEdicionCoach(payload);
    }

    return ok();
  } catch (e) {
    // El error se le muestra a quien toco el boton: si algo fallo tiene que
    // saberlo AHORA, porque el mensaje al cliente depende de esto.
    console.error('slack-interactividad', e);
    return efimero(`⚠️ No se pudo registrar en Zoho: ${String(e.message).slice(0, 300)}`);
  }
};

// ─── Coach de Ventas ───────────────────────────────────────────────────────

async function manejarCoach(payload, accion) {
  const caso = await obtener(accion.value);

  if (!caso) {
    return efimero(
      '⌛ Este caso ya no está guardado (se borran a los 14 días). El mensaje sigue en la tarjeta: copiarlo y mandarlo a mano.'
    );
  }
  if (caso.estado !== 'pendiente') {
    return efimero(`Este mensaje ya fue *${caso.estado}*${caso.aprobadoPor ? ` por ${caso.aprobadoPor}` : ''}.`);
  }

  const quien = payload.user?.id;
  const quienNombre = payload.user?.name || payload.user?.username || quien;
  const canal = payload.channel?.id || caso.slack?.canal;
  const ts = payload.message?.ts || caso.slack?.ts;

  if (accion.action_id === 'coach_editar') {
    // Un solo llamado a Slack: entra holgado en los 3 segundos.
    await slack('views.open', { trigger_id: payload.trigger_id, view: modalEdicion(caso) });
    await actualizar(caso.id, { slack: { canal, ts } });
    return ok();
  }

  if (accion.action_id === 'coach_descartar') {
    const actualizado = await actualizar(caso.id, { estado: 'descartado', descartadoPor: quienNombre });
    await slack('chat.update', { channel: canal, ts, ...armarTarjeta(actualizado, { estado: 'descartado', quien }) });
    return ok();
  }

  if (accion.action_id === 'coach_aprobar') {
    await aprobar({ caso, texto: caso.coach?.mensaje?.texto, quien, quienNombre, canal, ts });
    return ok();
  }

  return ok();
}

async function manejarEdicionCoach(payload) {
  const caso = await obtener(payload.view.private_metadata);
  const texto = payload.view.state?.values?.texto?.valor?.value || '';

  // Un `response_action: errors` deja el modal abierto con el texto puesto, asi
  // que el vendedor no pierde lo que escribio.
  if (!caso) {
    return ok(
      JSON.stringify({
        response_action: 'errors',
        errors: { texto: 'El caso ya no está guardado. Copiá el texto y mandalo a mano.' },
      })
    );
  }
  if (!texto.trim()) {
    return ok(JSON.stringify({ response_action: 'errors', errors: { texto: 'El mensaje no puede quedar vacío.' } }));
  }

  await aprobar({
    caso,
    texto,
    quien: payload.user?.id,
    quienNombre: payload.user?.name || payload.user?.username,
    canal: caso.slack?.canal,
    ts: caso.slack?.ts,
    editado: true,
  });
  return ok(); // cuerpo vacio = cerrar el modal
}

async function aprobar({ caso, texto, quien, quienNombre, canal, ts, editado = false }) {
  const r = await registrarAprobacion({ caso, texto, quien: quienNombre });

  const actualizado = await actualizar(caso.id, {
    estado: 'aprobado',
    aprobadoPor: quienNombre,
    textoFinal: texto,
    editado,
    zoho: r,
    slack: { canal, ts },
  });

  if (canal && ts) {
    await slack('chat.update', { channel: canal, ts, ...armarTarjeta(actualizado, { estado: 'aprobado', quien }) });
  }
  return r;
}
