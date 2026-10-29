// ¿Es seguro editar este lead?
//
// POR QUE EXISTE. Editar un lead en este CRM puede mandarle un WhatsApp a una
// persona real. En agosto de 2026 una regla en bucle mando la misma plantilla
// cada 3 minutos hasta que Meta bloqueo el numero de la empresa.
//
// MIRAR EL TIMELINE DESPUES DE ESCRIBIR NO ALCANZA, y conviene entender por que
// antes de confiar en cualquier agente que toque Leads. Las reglas no mandan el
// mensaje en el momento: activan un flujo. La plantilla
// `retargeting_30dias_dia_001_v4` sale UN DIA HABIL despues de la edicion. Un
// chequeo de 5 segundos da verde y sigue con los otros 3.900.
//
// COMO FUNCIONA ESTO. Los criterios de las reglas se leen de la API (v8,
// settings/automation/workflow_rules) y estan copiados abajo como estaban el
// 6-sep-2026. Un lead es seguro si NO cumple el criterio de ninguna regla que
// se dispare al editar. Si no se dispara ninguna, no pasa nada: no hay que
// adivinar que hace cada flujo.
//
// LA CASCADA ES LO PELIGROSO, no el envio directo. De las 54 reglas sobre
// Leads, 11 se disparan al editar y ninguna esta limitada a un campo: saltan
// con cualquier cambio. Varias no mandan nada pero ESCRIBEN `Lead_Status`
// ("Estado - Captacion", "Estado - Agendamiento", "Estado Retargeting"). Y hay
// otras 11 reglas, del tipo field_update, que vigilan `Lead_Status` y ahi si
// mandan tandas de 3 a 6 WhatsApp. El camino es:
//     escribo un campo cualquiera -> una regla pone Lead_Status -> arranca la tanda
//
// ANTE LA DUDA, NO. Si un campo que necesita una regla viene vacio o no se
// pidio, cuenta como que PODRIA cumplirse. Un falso "peligroso" cuesta un lead
// sin atribuir; un falso "seguro" cuesta un mensaje a alguien que ya compro.

/** Los campos que hay que pedirle a Zoho para poder decidir. */
export const CAMPOS_SEGURIDAD = [
  'Lead_Status', 'Tipo', 'Retargeting', 'N_mero_de_mensaje', 'reserva',
  'Tag', 'flujo_normal', 'Lead_Source', 'Paso_Retargeting',
];

const S = (v) => String(v ?? '').trim();
const vacio = (v) => S(v) === '';
const bool = (v) => v === true || S(v).toLowerCase() === 'true';
const etiquetas = (l) => (l.Tag || []).map((t) => S(t.name || t));
const tieneTag = (l, ...ns) => etiquetas(l).some((e) => ns.includes(e));

// Los estados que arrancan una tanda de mensajes en cuanto se escriben.
const ESTADOS_CON_TANDA = ['Captación', 'Agendamiento', 'Retargeting', 'Retargeting Lili', 'Comercial', 'No Show', 'Nurturing'];

const TAGS_FORM_META = ['Form Septiembre Meta', 'Form Nov Meta', 'From Instagram', 'FORM META AGOSTO A-B'];
const TAGS_LILI = ['Form LiliBank', 'Cuenta Bancaria - Lili'];

/**
 * @returns {{seguro: boolean, motivos: string[]}} motivos = que reglas se
 *   activarian. Vacio = no se dispara ninguna.
 */
export function seguroEditar(lead) {
  const m = [];
  const est = S(lead.Lead_Status);
  const tipo = S(lead.Tipo);
  const ret = bool(lead.Retargeting);
  const res = bool(lead.reserva);

  // --- las que mandan un mensaje directamente ---
  if (est === 'Captación') m.push('Flujo Captación: manda 3 WhatsApp en 6 días');
  if (est === 'Agendamiento') m.push('Flujo Agendamiento: manda 3 WhatsApp en 4 días');

  if (tipo === 'Apertura' && res && est === 'Retargeting' && !ret && vacio(lead.N_mero_de_mensaje))
    m.push('APERTURA Primer Mensaje Retargeting: WhatsApp a 1 día hábil');
  if (tipo === 'Apertura' && res && ret && est === 'SQL Calificado')
    m.push('APERTURA Primer Mensaje Retargeting (SQL): WhatsApp a 1 día hábil');
  if (tipo === 'Apertura' && ret && tieneTag(lead, 'Forma Captación Apertura'))
    m.push('APERTURA Primer Mensaje Retargeting: WhatsApp INMEDIATO');

  // --- las que no mandan pero escriben Lead_Status, y eso arranca la tanda ---
  if (!res && !bool(lead.flujo_normal) && tieneTag(lead, ...TAGS_FORM_META))
    m.push('Activar Flujo Captación: pondría Lead_Status=Captación y arranca la tanda');
  if (!res && !ret && vacio(tipo) && tieneTag(lead, 'Sin clasificar'))
    m.push('Activar flujo Agendamiento: pondría Lead_Status=Agendamiento y arranca la tanda');
  if (est === 'Nuevo MQL' && tipo === 'Apertura' && ret)
    m.push('Activar Flujo Retargeting: pondría Lead_Status=Retargeting y arranca la tanda');
  if (tieneTag(lead, ...TAGS_LILI))
    m.push('Activar Retargeting Lili: pondría Lead_Status=Retargeting Lili y arranca la tanda');
  if (est === 'Retargeting' && !ret && tipo === 'Cuenta Bancaria')
    m.push('CUENTA BANCARIA Retargeting Relay');
  if (S(lead.Lead_Source) === 'Web Organic' && !res)
    m.push('Asignacion Source: escribe el estado del lead');

  // --- el lead ya esta adentro de una tanda: no se lo toca ni de casualidad ---
  if (ESTADOS_CON_TANDA.includes(est) && !m.length)
    m.push(`Lead_Status="${est}": ya está dentro de un flujo de mensajes`);

  // --- ante la duda, no ---
  const faltan = CAMPOS_SEGURIDAD.filter((c) => !(c in lead));
  if (faltan.length) m.push(`no se pidieron los campos ${faltan.join(', ')}: no se puede decidir`);

  return { seguro: m.length === 0, motivos: m };
}
