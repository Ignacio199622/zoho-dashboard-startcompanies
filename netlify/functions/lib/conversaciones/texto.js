// WhatsApp deja pasar mensajes con cientos de caracteres invisibles adelante
// (zero-width space, joiners, marcas de direccion). Se ven vacios en la
// pantalla de Zoho pero llegan en el texto: el mensaje de un lead real del
// 3-sep traia ~120 de esos antes de "Vengo de la web Crea tu LLC".
// Sin limpiarlos, la alerta de Slack sale rota y el modelo gasta tokens en nada.
const INVISIBLES = /[​-‏‪-‮⁠-⁤﻿­]/g;

export function limpiar(texto) {
  if (!texto) return '';
  return String(texto).replace(INVISIBLES, '').replace(/[ \t]+\n/g, '\n').trim();
}
