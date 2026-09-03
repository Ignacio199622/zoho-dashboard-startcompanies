/*
 * auth.js — server-side gate for the dashboard functions.
 *
 * Until now the login screen lived entirely in the browser: index.html carried a
 * table of SHA-256 hashes and decided by itself whether to show the dashboard.
 * The data functions asked for nothing, so anyone with the URL could download the
 * full lead database with curl. This moves the decision to the server.
 *
 * Shared password (env DASHBOARD_PASSWORD) -> short-lived signed token. The token
 * is an HMAC over its own expiry, so no session storage is needed and a stolen
 * token dies on its own.
 *
 * Fails CLOSED: with no DASHBOARD_PASSWORD configured every endpoint answers 503
 * rather than serving data.
 */
const crypto = require('crypto');

const TTL_MS = 12 * 60 * 60 * 1000;   // 12 h — one working day, then log in again

function claveMaestra() {
  const base = process.env.DASHBOARD_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!base) return null;
  return crypto.createHash('sha256').update('sc-dashboard:' + base).digest();
}

// Dos niveles. "direccion" ve todo; "equipo" ve lo que no es plata: biblioteca,
// decisiones, guias y el pulso de tareas. El rol va DENTRO de la firma, asi que
// no se puede editar el token para ascender de nivel.
const NIVEL = { equipo: 1, direccion: 2 };

function firmar(exp, rol) {
  return crypto.createHmac('sha256', claveMaestra()).update(exp + ':' + rol).digest('hex');
}

function emitirToken(rol = 'direccion') {
  const exp = Date.now() + TTL_MS;
  return exp + '.' + rol + '.' + firmar(exp, rol);
}

/**
 * Devuelve { exp, rol } o null. Acepta el formato viejo de dos partes
 * (`exp.firma`) como direccion: si no, al deployar esto se caeria la sesion de
 * todos los que ya estaban adentro.
 */
function datosToken(token) {
  if (!token || !claveMaestra()) return null;
  const partes = String(token).split('.');
  const rol = partes.length === 3 ? partes[1] : 'direccion';
  if (partes.length < 2 || partes.length > 3 || !NIVEL[rol]) return null;
  const exp = Number(partes[0]);
  if (!exp || Number.isNaN(exp) || Date.now() > exp) return null;
  const esperada = Buffer.from(
    partes.length === 3
      ? firmar(exp, rol)
      : crypto.createHmac('sha256', claveMaestra()).update(String(exp)).digest('hex')
  );
  const recibida = Buffer.from(String(partes[partes.length - 1]));
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
  return { exp, rol };
}

function tokenValido(token) {
  return Boolean(datosToken(token));
}

// Hash both sides first so the comparison is constant time regardless of length.
function coincide(intento, real) {
  if (!real || typeof intento !== 'string') return false;
  const a = crypto.createHash('sha256').update(intento).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Que rol abre esta clave: la de direccion, la del equipo, o ninguna. */
function rolDeClave(intento) {
  if (coincide(intento, process.env.DASHBOARD_PASSWORD)) return 'direccion';
  if (coincide(intento, process.env.EQUIPO_PASSWORD)) return 'equipo';
  return null;
}

function claveCorrecta(intento) {
  return rolDeClave(intento) !== null;
}

function leerBearer(headers) {
  const h = headers || {};
  const raw = h.authorization || h.Authorization || '';
  return raw.startsWith('Bearer ') ? raw.slice(7) : '';
}

// CORS was '*', which let any site read these endpoints from a victim's browser.
function cabeceras(headers) {
  const permitido = process.env.DASHBOARD_ORIGIN || '';
  const origen = (headers && (headers.origin || headers.Origin)) || '';
  return {
    'Access-Control-Allow-Origin': permitido || origen,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Content-Type': 'application/json'
  };
}

// Returns a ready-to-send error response, or null when the request may proceed.
function exigirAuth(headers, cabecerasRespuesta, rolMinimo = 'equipo') {
  if (!claveMaestra()) {
    return { statusCode: 503, headers: cabecerasRespuesta,
      body: JSON.stringify({ error: 'Falta configurar DASHBOARD_PASSWORD en Netlify' }) };
  }
  const datos = datosToken(leerBearer(headers));
  if (!datos) {
    return { statusCode: 401, headers: cabecerasRespuesta,
      body: JSON.stringify({ error: 'No autorizado' }) };
  }
  if (NIVEL[datos.rol] < NIVEL[rolMinimo]) {
    return { statusCode: 403, headers: cabecerasRespuesta,
      body: JSON.stringify({ error: 'Esta sección es solo para dirección' }) };
  }
  return null;
}

module.exports = { TTL_MS, NIVEL, emitirToken, tokenValido, datosToken, claveCorrecta, rolDeClave, claveMaestra, leerBearer, cabeceras, exigirAuth };
