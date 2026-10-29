/*
 * Vigia de una plantilla de WhatsApp esperando la aprobacion de Meta.
 *
 * Ignacio (25-sep-2026): "ok avise si ya esta". En vez de que alguien se acuerde de
 * mirarlo, lo mira el agente que ya corre cada 5 min y avisa a Slack cuando cambia.
 *
 * Es ultra-conservador con la cuota de Meta (ver feedback_meta_api_conservative):
 *   - UNA sola llamada, y como mucho cada 2 h (12 por dia, no 288).
 *   - En cuanto deja de estar PENDING avisa y se APAGA solo: nunca mas vuelve a llamar.
 *   - Si Meta falla, se calla y reintenta a las 2 h. No ensucia Slack con errores de red.
 *
 * Para vigilar otra plantilla mas adelante, agregar una entrada a VIGILADAS.
 */
const CADA_MS = 2 * 3600e3;

const VIGILADAS = [
  {
    id: '2643895606130948',
    nombre: 'cliente_confirmacion_24h_v2',
    // Que hacer cuando Meta la apruebe, para que el aviso sea accionable.
    alAprobar:
      'Ya se puede cambiar el circuito de Clientes a la v2 y recien ahi borrar la vieja `cliente_confirmacion_24h`.',
  },
];

/**
 * @param memoria  el blob del agente (se lee y se devuelve el pedazo actualizado)
 * @returns { lineas, estado } - lineas para Slack (vacio = nada que decir)
 */
export async function revisarPlantillas(memoria = {}, ahora = new Date()) {
  const estado = { ...(memoria.plantillas || {}) };
  const lineas = [];
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!token) return { lineas, estado };

  for (const p of VIGILADAS) {
    const previo = estado[p.id] || {};
    if (previo.listo) continue; // ya avisamos: no se consulta nunca mas
    if (previo.ultima && ahora - new Date(previo.ultima) < CADA_MS) continue;

    let j;
    try {
      const r = await fetch(
        `https://graph.facebook.com/v21.0/${p.id}?fields=status,rejected_reason&access_token=${token}`,
        { signal: AbortSignal.timeout(15000) }
      );
      j = await r.json();
    } catch {
      continue; // se reintenta en 2 h
    }
    if (!j || j.error || !j.status) continue;

    estado[p.id] = { ...previo, ultima: ahora.toISOString(), status: j.status };
    if (j.status === 'PENDING') continue;

    estado[p.id].listo = true;
    if (j.status === 'APPROVED') {
      lineas.push(`:white_check_mark: Meta aprobó la plantilla *${p.nombre}* (con los botones Sí / No). ${p.alAprobar}`);
    } else {
      const motivo = j.rejected_reason && j.rejected_reason !== 'NONE' ? ` Motivo: ${j.rejected_reason}.` : '';
      lineas.push(`:x: Meta dejó la plantilla *${p.nombre}* en *${j.status}*.${motivo} Hay que corregirla y reenviarla.`);
    }
  }
  return { lineas, estado };
}
