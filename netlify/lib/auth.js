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

function firmar(exp) {
  return crypto.createHmac('sha256', claveMaestra()).update(String(exp)).digest('hex');
}

function emitirToken() {
  const exp = Date.now() + TTL_MS;
  return exp + '.' + firmar(exp);
}

function tokenValido(token) {
  if (!token || !claveMaestra()) return false;
  const partes = String(token).split('.');
  if (partes.length !== 2) return false;
  const exp = Number(partes[0]);
  if (!exp || Number.isNaN(exp) || Date.now() > exp) return false;
  const esperada = Buffer.from(firmar(exp));
  const recibida = Buffer.from(String(partes[1]));
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

// Hash both sides first so the comparison is constant time regardless of length.
function claveCorrecta(intento) {
  const real = process.env.DASHBOARD_PASSWORD;
  if (!real || typeof intento !== 'string') return false;
  const a = crypto.createHash('sha256').update(intento).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
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
function exigirAuth(headers, cabecerasRespuesta) {
  if (!claveMaestra()) {
    return { statusCode: 503, headers: cabecerasRespuesta,
      body: JSON.stringify({ error: 'Falta configurar DASHBOARD_PASSWORD en Netlify' }) };
  }
  if (!tokenValido(leerBearer(headers))) {
    return { statusCode: 401, headers: cabecerasRespuesta,
      body: JSON.stringify({ error: 'No autorizado' }) };
  }
  return null;
}

module.exports = { TTL_MS, emitirToken, tokenValido, claveCorrecta, claveMaestra, leerBearer, cabeceras, exigirAuth };
