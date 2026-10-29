/*
 * Quién es el cliente en una reserva de Cal.
 *
 * 29-oct-2026: a las reuniones de Brasil se suma a Thais como invitada
 * (conversaciones/invitar-thais.js) y Cal la pone PRIMERA en `attendees`. Todo lo que
 * tomaba attendees[0] como el cliente pasaba a leer a Thais: la cancelación no
 * encontraba la reunión y una reagenda podía crear un lead a su nombre.
 * El cliente es el primer invitado que no es del equipo; si todos lo son (una prueba,
 * o alguien del equipo que reservó para un cliente), queda el primero, como antes.
 */
export const esDelEquipo = (a) => /@startcompanies\./i.test(a?.email || '');

export function clienteDe(b) {
  const lista = b?.attendees || [];
  return lista.find((a) => !esDelEquipo(a)) || lista[0];
}
