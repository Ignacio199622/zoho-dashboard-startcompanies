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
