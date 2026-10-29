// Quién se hace cargo de cada tipo de problema.
//
// El mensaje de la mañana reparte por PERSONA, no por tema: cada uno tiene que
// abrir el suyo y cerrarlo. Sin este mapa habría que agrupar por el dueño del
// registro en Zoho, y no sirve: el 88% de los registros los creó la integración
// `Start Companies Staff`, así que casi todo caería en "sin dueño".
//
// Los nombres son los de Slack, escritos tal cual. Se mencionan por nombre, no
// por id: alcanza para que cada uno sepa qué le toca.
//
// Aprobado por Ignacio el 3-sep-2026.
// PARA CAMBIARLO: se edita solamente este archivo.
export const RESPONSABLES = {
  'cadencias-vencidas': 'Benjamin',
  'duplicados': 'Adrian',
  'lead-de-cliente': 'Adrian',
  'llc-sin-propietario': 'Pablo',
  'estructura': 'Pablo',
  'reuniones-sin-marcar': 'Nacho Campo',
  'tratos-frenados': 'Nacho Campo',
  // Agregada el 3-sep-2026 con la regla del pulso de entrada. No es un error de
  // carga sino una integracion caida: la plata ya se gasto en Meta y el lead no
  // entro. Va a Ignacio hasta que el decida moverla.
  'canal-sin-leads': 'Ignacio',
  // Los leads de Meta recuperados entran sin cadencia: los llama ventas.
  'meta-sin-contactar': 'Nacho Campo',
  // Misma persona que las cadencias vencidas: es el mismo motor.
  'mensajes-que-no-salieron': 'Benjamin',
  // Agregada el 13-sep-2026: WhatsApp oculta el numero y la cadencia no llega.
  // Se resuelve contestando en el chat, asi que va a quien atiende WhatsApp.
  'whatsapp-sin-numero': 'Nacho Campo',
  // Las renovaciones y la ficha de la LLC son de Pablo.
  'renovacion-desfasada': 'Pablo',
  // El puente CRM -> pixel de Meta, agregado el 5-sep-2026.
  // El mapeo de la conversion Posible cliente -> Trato lo toca Benjamin.
  'puente-trato-sin-id': 'Benjamin',
  // La fila que falta en las cadenas de Lead Chain la toca Adrian.
  'puente-meta-sin-tipo': 'Adrian',
  // Estos dos son de decision, no de carga: van a Ignacio.
  'puente-senal-sin-id': 'Ignacio',
  'puente-sin-senal': 'Ignacio',
  // Agregada el 7-sep-2026. Va a Pablo porque el dato de origen es el lookup
  // `Socio` de la LLC, y la ficha de la LLC ya es suya (llc-sin-propietario,
  // estructura, renovacion-desfasada). Se arregla corriendo dos scripts:
  //   crm/auditoria/canal-partners.js --aplicar
  //   crm/auditoria/partner-en-trato.js --aplicar
  'trato-partner-sin-marcar': 'Pablo',
  // Agregada el 9-sep-2026. Es el parte de las ventas nuevas: quien las carga es
  // quien puede completar lo que falta en el momento, no dos semanas despues.
  'tratos-nuevos': 'Pablo',
  // Agregada el 12-sep-2026 por el caso Bernabei/Petruccelli: un lead renombrado y
  // fusionado en la ficha de otro desde la cuenta compartida. Es de decision (quien
  // usa esa cuenta y por que), no de carga: va a Ignacio.
  'fusion-sospechosa': 'Ignacio',
  // Agregada el 30-sep-2026 por el caso FUTURE LABS: leads convertidos dentro de la
  // LLC de otro cliente. Es de carga de ventas, al convertir: Nacho Campo.
  'reuniones-en-llc-ajena': 'Nacho Campo',
  // Agregadas el 13-sep-2026: que posible cliente anda sin retargeting y por que.
  // Si el flujo no arranco o se corto, es la automatizacion de Zoho: Adrian.
  'sin-retargeting-flujo': 'Adrian',
  // Si esta en un estado sin cadencia (En Calificacion, Reunion Agendada pasada,
  // baja a mano), alguien de ventas lo tiene que mover: Nacho.
  'sin-retargeting-estado': 'Nacho Campo',
};

// El que recibe lo que no tiene responsable asignado.
export const POR_DEFECTO = 'Nacho Campo';

export const responsableDe = (clave) => RESPONSABLES[clave] || POR_DEFECTO;

/** Da vuelta el mapa: para cada persona, qué reglas le tocan. */
export function porPersona(reglas) {
  const m = new Map();
  for (const r of reglas) {
    const quien = responsableDe(r.clave);
    (m.get(quien) || m.set(quien, []).get(quien)).push(r);
  }
  return m;
}
