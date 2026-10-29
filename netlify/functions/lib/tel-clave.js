/**
 * Clave única de un teléfono para la memoria de Matías (`apertura-`, `hilo-`, `turno-`, `envio-`).
 *
 * México: Zoho guarda el celular como 52 + 10 dígitos, pero WhatsApp lo manda como 52 1 + 10
 * (el "1" de los celulares viejos). Sin esto la misma persona tenía dos fichas: la apertura y los
 * toques en una, sus respuestas en otra, y Matías la saludaba de cero (Ignacio Zermeno, 1-oct).
 */
export function claveTel(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  return /^52\d{10}$/.test(d) ? `521${d.slice(2)}` : d;
}
