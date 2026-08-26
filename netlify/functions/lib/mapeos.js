// Como se traduce lo que saca el agente a los valores que acepta Zoho.
//
// Todo lo que sea una decision de negocio vive aca, no enterrado en el codigo,
// para que se pueda revisar y cambiar sin tocar la logica.

// --- Vendedores: nombre en la llamada -> usuario de Zoho ---
// Lista real, leida de /users con el token ampliado (users.READ).
// Reemplaza a la que se habia deducido de los Owner de los registros: esa
// incluia a "Tomas" y "Belen Contreras", que ya NO son usuarios activos aunque
// sigan figurando como propietarios de registros viejos.
// `vende: false` = tiene usuario en Zoho pero no atiende llamadas de venta, asi
// que el agente nunca le va a asignar una.
//
// Quien vende (confirmado por Ignacio, 2026-08-11): Santiago Cuellar e Ignacio
// Navarro. Camila Salazar e Ignacio Campo hacen FILING (el tramite de
// constitucion), no ventas: pueden aparecer en llamadas de soporte o
// seguimiento, pero nunca son el vendedor de un Deal. Daniel Alvarado es un
// externo que esta probando cosas y Adrian entro por operaciones/Zoho.
export const USUARIOS = {
  '6698625000041418001': { nombre: 'Santiago Cuellar', mail: 'santiago@startcompanies.io', vende: true },
  '6698625000002192001': { nombre: 'Ignacio Navarro', mail: 'ignacio@startcompanies.net', vende: true },
  '6698625000048708001': { nombre: 'Camila Salazar', mail: 'camila@startcompanies.io', vende: false, area: 'filing' },
  '6698625000002191001': { nombre: 'Ignacio Campo', mail: 'ignaciocampo@startcompanies.net', vende: false, area: 'filing' },
  '6698625000023935001': { nombre: 'Daniel Alvarado', mail: 'dany@thepauta.com', vende: false },
  '6698625000050962001': { nombre: 'Adrián Darío Calabró', mail: 'calabroadrian@gmail.com', vende: false },
  '6698625000000502001': { nombre: 'Start Companies Staff', mail: 'administracion@startcompanies.net', generico: true },
};

// Ya no hay ambiguedad entre los dos Ignacios: Campo hace filing y no vende,
// asi que en una llamada de ventas "Ignacio" solo puede ser Navarro.
export const IGNACIO_POR_DEFECTO = '6698625000002192001'; // Ignacio Navarro

const NORM = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim();

/**
 * @returns {{id:string|null, motivo:string}}
 */
export function usuarioDesdeNombre(nombreEnLlamada) {
  const n = NORM(nombreEnLlamada);
  if (!n) return { id: null, motivo: 'la llamada no menciona quien atendio' };

  const todos = Object.entries(USUARIOS).filter(([, u]) => !u.generico);

  // Se busca contra TODOS los usuarios, no solo los que venden. Si no, un
  // "Ignacio Campo" explicito caeria en el match por nombre de pila y le
  // asignaria la venta a Ignacio Navarro, que es justo lo que no queremos.
  const resolver = (id, motivo) => {
    const u = USUARIOS[id];
    if (!u.vende) {
      return { id: null, motivo: `${u.nombre} no atiende ventas${u.area ? ` (${u.area})` : ''}` };
    }
    return { id, motivo };
  };

  const exacto = todos.find(([, u]) => NORM(u.nombre) === n);
  if (exacto) return resolver(exacto[0], 'nombre completo');

  // El apellido es lo que desambigua entre dos personas del mismo nombre.
  const porApellido = todos.filter(([, u]) => {
    const partes = NORM(u.nombre).split(/\s+/);
    return partes.length > 1 && n.includes(partes[partes.length - 1]);
  });
  if (porApellido.length === 1) return resolver(porApellido[0][0], 'apellido');

  const porPila = todos.filter(([, u]) => NORM(u.nombre).split(/\s+/)[0] === n.split(/\s+/)[0]);
  if (porPila.length === 1) return resolver(porPila[0][0], 'nombre de pila, unico');
  if (porPila.length > 1) {
    // Varios comparten el nombre de pila. Si solo uno de ellos vende, es ese.
    const queVenden = porPila.filter(([, u]) => u.vende);
    if (queVenden.length === 1) {
      return { id: queVenden[0][0], motivo: `"${nombreEnLlamada}" es ambiguo, pero solo ${USUARIOS[queVenden[0][0]].nombre} atiende ventas` };
    }
    return { id: null, motivo: `"${nombreEnLlamada}" puede ser ${porPila.map(([, u]) => u.nombre).join(' o ')}` };
  }

  return { id: null, motivo: `"${nombreEnLlamada}" no coincide con ningun usuario de Zoho` };
}

// --- Estado de la reunion (Status_del_Meet) ---
// Valores validos del picklist: Asistió / No asistió / Reagendar / Asistió sin interés
//
// OJO: que exista grabacion NO prueba que el cliente vino. Fathom graba en
// cuanto el vendedor entra a la reunion, asi que hay grabaciones enteras del
// vendedor esperando solo. Lo que decide es el contenido de la llamada, no que
// el archivo exista. Se detectaron 2 casos asi en 90 llamadas.
export function estadoDelMeet(resultado, hayGrabacion, sePresento) {
  if (!hayGrabacion) return { valor: null, motivo: 'sin grabacion no se puede afirmar nada' };
  if (sePresento === false) {
    return { valor: 'No asistió', motivo: 'hay grabacion pero en la llamada consta que el cliente no se unio' };
  }
  if (sePresento !== true) {
    return { valor: null, motivo: 'la llamada no permite afirmar si el cliente se presento' };
  }
  if (resultado === 'no_calificado') return { valor: 'Asistió sin interés', motivo: 'vino, pero no califica' };
  return { valor: 'Asistió', motivo: 'la llamada confirma que el cliente participo' };
}

// --- Estado del lead (Lead_Status) ---
// Solo se toca para marcar el "no califica": el resto de los estados los maneja
// el pipeline y no le corresponde al agente moverlos.
export function estadoDelLead(resultado) {
  if (resultado === 'no_calificado') return { valor: 'No Calificado', motivo: 'la llamada mostro que no es cliente posible' };
  return { valor: null, motivo: 'el pipeline maneja este estado' };
}

// --- Modalidad de cierre ---
// Valores validos: Llamada / Retargeting de vendedor / Retargeting empresa /
// Sin información / Anticipo / No cerró / Pago total
export function modalidadDeCierre(resultado) {
  if (resultado === 'cerro_en_la_llamada') return { valor: 'Llamada', motivo: 'cerro durante la llamada' };
  if (resultado === 'no_calificado') return { valor: 'No cerró', motivo: 'no califica' };
  // "quedo pendiente" NO es "No cerró": todavia puede cerrar despues.
  return { valor: null, motivo: 'sigue abierto, todavia puede cerrar' };
}

// --- Landing de origen ---
// El slug que manda Cal.com -> el picklist Landing_Origen de Zoho.
// Ojo: el picklist mezcla canal (Meta Ads) con landing, asi que el mapeo dice
// de que CANAL viene cada landing, que es como lo usa el dashboard.
export const LANDING_A_CANAL = {
  'asesoria-llc': 'Meta Ads',
  'llc-7-dias': 'Meta Ads',
  'abre-tu-llc': 'Meta Ads',
  'abre-tu-llc-ads': 'Meta Ads',
  presentacion: 'Meta Ads',
  'crear-llc-usa': 'SEO / Web Orgánica',
  'abrir-llc-estados-unidos': 'YouTube Ads',
  'agenda-organica': 'SEO / Web Orgánica',
};

export function canalDesdeLanding(lp) {
  if (!lp) return { valor: null, motivo: 'la reserva no trae landing' };
  const k = String(lp).toLowerCase().replace(/^\//, '');
  const canal = LANDING_A_CANAL[k];
  if (!canal) return { valor: null, motivo: `landing "${lp}" sin canal asignado en el mapeo` };
  return { valor: canal, motivo: `landing ${k}` };
}
