// Que pasa cuando el vendedor toca "Aprobar" en Slack.
//
// La usa tanto la funcion de Netlify (el boton) como el CLI, para que el
// comportamiento sea uno solo y no dos que se parecen.
//
// LO QUE ESCRIBE:
//   - una nota y una tarea (registros nuevos, no disparan nada)
//   - el Propietario del lead, SOLO si esta en la cuenta generica, para dejar
//     asentado quien atendio la llamada. Esta es la unica escritura que EDITA
//     el lead, y editar un lead en este CRM puede disparar envios al cliente
//     (agosto 2026: una regla en bucle mando la misma plantilla cada 3 minutos
//     hasta que Meta bloqueo el numero). Por eso tiene corte de seguridad.
// LO QUE NO TOCA, A PROPOSITO:
//   - No prende `Retargeting`. La cadencia hoy entra por el mensaje 2 y el 76%
//     se congela en el 3; meter gente ahi automaticamente es empeorarlo. El
//     coach recomienda, la persona decide.
import { env } from './entorno.js';

const API = 'https://www.zohoapis.com/crm/v6';

// La cuenta generica. Un lead que es de ella es un lead sin dueno de verdad.
const GENERICO = '6698625000000502001'; // Start Companies Staff

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
 * EL CORTE DE SEGURIDAD.
 *
 * Escribir el Propietario es lo unico que EDITA el lead, y editar un lead en
 * este CRM puede disparar un envio al cliente: en agosto de 2026 una regla en
 * bucle mando la misma plantilla cada 3 minutos hasta que Meta bloqueo el
 * numero. Asi que despues de cada escritura se mira el timeline del lead, y si
 * salio un mensaje se apaga la funcion para siempre (hasta que una persona
 * borre la marca del almacen). No se puede deshacer el envio que ya salio, pero
 * si evitar el segundo, el tercero y los cien siguientes.
 *
 * Para reactivarlo despues de revisar: borrar la clave `coach-vendedor-apagado`.
 */
const CLAVE_APAGADO = 'coach-vendedor-apagado';

export async function escrituraDeVendedorApagada() {
  const { leer } = await import('./almacen.js');
  return (await leer(CLAVE_APAGADO, null)) || null;
}

async function apagarEscrituraDeVendedor(motivo) {
  const { guardar } = await import('./almacen.js');
  await guardar(CLAVE_APAGADO, { cuando: new Date().toISOString(), motivo });
}

/** Mensajes que el CRM le mando al cliente despues de un momento dado. */
async function huboEnvios(leadId, desde, token) {
  const j = await zoho(`Leads/${leadId}/__timeline?per_page=25`, {}, token);
  return (j.__timeline || []).filter((t) => {
    if (new Date(t.audited_time).getTime() < desde) return false;
    return /messagenotificationsent|email_notification|notification/i.test(t.action || '');
  });
}

/**
 * Registra en Zoho el mensaje aprobado y el seguimiento.
 *
 * @param {object} caso    lo guardado por el coach
 * @param {string} texto   el mensaje final (puede venir editado desde el modal)
 * @param {string} quien   nombre de quien aprobo en Slack
 * @returns {Promise<{notaId: string, tareaId: string|null, vendedor: object}>}
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
    // El seguimiento lo hace quien atendio la llamada. Si no se pudo resolver,
    // cae al dueno del lead; y si ese es el generico, queda sin asignar antes
    // que asignarsela a la persona equivocada.
    const responsable = caso.vendedor?.id || caso.lead?.Owner?.id;
    if (responsable && responsable !== GENERICO) tarea.Owner = responsable;
    pedirTarea = zoho('Tasks', { method: 'POST', body: JSON.stringify({ data: [tarea] }) }, t);
  }

  // --- 3. El vendedor en el lead --------------------------------------
  //
  // OJO CON EL CAMPO: `Quien_lo_vendio` existe en **Tratos**, no en Posibles
  // clientes (verificado contra el esquema el 3-sep-2026). El coach trabaja
  // sobre leads que todavia no cerraron, asi que ahi no hay donde escribirlo.
  // El equivalente en un lead es el **Propietario**, que ademas es el campo que
  // esta roto: 68 de los 100 leads mas nuevos son de "Start Companies Staff",
  // la cuenta generica. Poner al vendedor real ahi arregla la atribucion y de
  // paso hace que la tarea de seguimiento le llegue a quien corresponde.
  //
  // Es la unica escritura que EDITA el lead. Solo se hace si: se resolvio a un
  // usuario real, el lead esta en la cuenta generica (nunca se le saca un lead
  // a una persona), y el corte de seguridad no esta activado.
  const v = caso.vendedor || {};
  const apagado = await escrituraDeVendedorApagada();
  const duenoActual = caso.lead?.Owner?.id;
  const esGenerico = !duenoActual || duenoActual === GENERICO;
  let vendedor = { escrito: false, motivo: v.motivo || 'sin vendedor resuelto' };

  if (apagado) {
    vendedor.motivo = `apagado el ${apagado.cuando.slice(0, 10)}: ${apagado.motivo}`;
  } else if (v.id && !esGenerico) {
    vendedor.motivo = `el lead ya es de ${caso.lead.Owner.name}, no se le saca`;
  } else if (v.id) {
    const t0 = Date.now();
    try {
      const ju = await zoho(
        'Leads',
        { method: 'PUT', body: JSON.stringify({ data: [{ id: leadId, Owner: { id: v.id } }] }) },
        t
      );
      const ru = (ju.data || [])[0];
      if (ru?.code !== 'SUCCESS') throw new Error(`${ru?.code} ${ru?.message}`);
      vendedor = { escrito: true, id: v.id, nombre: v.nombre, motivo: v.motivo };

      const envios = await huboEnvios(leadId, t0 - 5000, t);
      if (envios.length) {
        await apagarEscrituraDeVendedor(
          `editar el lead ${leadId} disparo ${envios.length} envio(s) al cliente`
        );
        vendedor.alerta = `⚠️ editar el lead disparó ${envios.length} mensaje(s) al cliente. Se apagó la escritura de vendedor.`;
      }
    } catch (e) {
      // Que falle esto no invalida la aprobacion: la nota y la tarea ya estan.
      vendedor = { escrito: false, motivo: `no se pudo escribir: ${String(e.message).slice(0, 120)}` };
    }
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

  return { notaId: rn.details?.id, tareaId, vendedor };
}

/** Deja constancia de que se descarto, sin ensuciar el CRM. */
export async function registrarDescarte({ caso, quien }) {
  return { registrado: false, motivo: 'los descartes no se escriben en Zoho' };
}
