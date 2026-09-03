// Normalizar telefonos para poder cruzarlos.
//
// El mismo cliente aparece como "+54 9 11 5555-4444" en el lead y como
// "5491155554444" en el modulo de mensajes. Se comparan por los ultimos
// digitos, que es lo unico estable: los prefijos de pais y el 9 de Argentina
// aparecen y desaparecen segun quien cargo el dato.

/** Solo digitos, y nos quedamos con los ultimos 10 (alcanza para identificar). */
export function limpiarNumero(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (d.length < 8) return null;
  return d.slice(-10);
}

/** El telefono del lead: el CRM lo carga en Mobile mucho mas que en Phone. */
export function telefonoDelLead(lead) {
  return lead?.Mobile || lead?.Phone || null;
}

/** Link que abre WhatsApp con el mensaje ya escrito. Un toque y sale. */
export function linkWhatsApp(telefono, texto) {
  const d = String(telefono || '').replace(/\D/g, '');
  if (d.length < 8) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`;
}
