/*
 * Login endpoint: shared password in, signed token out.
 * The password never travels to the browser and is not stored in the page.
 */
const { emitirToken, rolDeClave, claveMaestra, cabeceras, TTL_MS } = require('../lib/auth');

exports.handler = async (event) => {
  const headers = cabeceras(event.headers);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }
  if (!claveMaestra()) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Falta configurar DASHBOARD_PASSWORD en Netlify' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { /* queda vacío */ }

  // Small fixed delay: makes an online brute force impractical without needing
  // shared rate-limit state across lambda instances.
  await new Promise(r => setTimeout(r, 400));

  // La misma pantalla de login para los dos: la clave decide el rol. El front
  // usa "rol" para saber que secciones mostrar; el servidor no le cree a nadie y
  // lo vuelve a chequear en cada funcion.
  const rol = rolDeClave(body.password);
  if (!rol) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Contraseña incorrecta' }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ token: emitirToken(rol), rol, expiraEn: TTL_MS })
  };
};
