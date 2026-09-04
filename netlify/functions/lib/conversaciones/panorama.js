// La foto de todo lo que sigue abierto, cada 2 horas.
//
// Es distinto de las alertas: la alerta es un caso para tomar ahora, esto es el
// estado del tablero. Sin esto, lo que nadie tomó se va hundiendo en el canal y
// a los tres días ya nadie lo ve.
//
// No cuesta llamadas al CRM: sale de lo que el agente ya tiene anotado. Las
// conversaciones que quedaron esperando estan en `esperandoRespuesta` (la misma
// lista que usa el aprendizaje, que se vacia sola cuando alguien contesta) y las
// ventas en `ventasAbiertas`.
import { EQUIPOS, RUTEO, nombrar, webhookDe, SLACK_WEBHOOK_URL, TEMAS_QUE_NO_SE_SUELTAN } from './config.js';
import { TEMAS } from './clasificar.js';

const edad = (desde, ahora) => {
  const h = (ahora - new Date(desde)) / 3600000;
  return h >= 24 ? `${Math.floor(h / 24)}d` : `${Math.round(h)}h`;
};

export function armar(estado, ahora = new Date()) {
  const pendientes = Object.entries(estado.esperandoRespuesta || {})
    .map(([id, p]) => ({ id, ...p, edad: edad(p.cuando, ahora), horas: (ahora - new Date(p.cuando)) / 3600000 }))
    // Lo que el clasificador marco como ruido no entra: un "gracias" sin
    // contestar no es un pendiente.
    .filter((p) => p.categoria && p.categoria !== 'ruido')
    .sort((a, b) => b.horas - a.horas);

  const ventas = Object.entries(estado.ventasAbiertas || {})
    .map(([id, v]) => ({ id, ...v, edad: edad(v.abierto, ahora), horas: (ahora - new Date(v.abierto)) / 3600000 }))
    .sort((a, b) => b.horas - a.horas);

  return { pendientes, ventas };
}

export async function enviar(estado, ahora = new Date()) {
  const { pendientes, ventas } = armar(estado, ahora);
  if (!pendientes.length && !ventas.length) return null;

  const hora = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ahora);

  const quienes = (tema) => {
    const e = EQUIPOS[RUTEO[tema]?.[0] || 'cx'];
    return (e?.personas || []).map(nombrar).join(' ');
  };

  const partes = [
    `📋 *Estado a las ${hora}* — ${pendientes.length} sin contestar, ${ventas.length} venta${ventas.length === 1 ? '' : 's'} sin cerrar`,
  ];

  if (pendientes.length) {
    partes.push(
      '*Sin contestar*\n' +
        pendientes
          .map(
            (p) =>
              `• *${p.quien || 'Sin nombre'}* (${p.edad}) · ${TEMAS[p.tema] || ''} · ${quienes(p.tema)} — ` +
              `${String(p.resumen || p.mensaje).replace(/\s+/g, ' ').slice(0, 90)}`
          )
          .join('\n')
    );
  }

  if (ventas.length) {
    partes.push(
      '*Contestadas pero sin cerrar*\n' +
        ventas
          .map((v) => `• 💰 *${v.quien}* (${v.edad}) · ${quienes(v.tema)} — ${String(v.resumen || '').slice(0, 90)}`)
          .join('\n')
    );
  }

  const url = webhookDe('cx') || SLACK_WEBHOOK_URL;
  if (!url) return { enviado: false, partes };

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${pendientes.length} sin contestar, ${ventas.length} sin cerrar`,
      blocks: partes.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
    }),
  });
  return { enviado: true, pendientes: pendientes.length, ventas: ventas.length };
}

/** El panorama va en las horas pares: 10, 12, 14, 16 y 18. */
export function toca(ahora = new Date()) {
  const h = Number(
    new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: '2-digit',
      hour12: false,
    }).format(ahora)
  );
  return h % 2 === 0;
}
