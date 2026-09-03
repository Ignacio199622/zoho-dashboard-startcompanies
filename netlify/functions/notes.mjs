/*
 * Shared notes, stored in Netlify Blobs.
 *
 * This used to be a lambda-compat (`exports.handler`) function and Blobs failed
 * at runtime with MissingBlobsEnvironmentError — the Blobs context is only
 * injected into the modern function runtime. The whole notes feature was dead in
 * production and failed silently, so nobody noticed. Rewritten in the v2 format,
 * which gets that context, and closed behind the same token as the data endpoint.
 */
import { getStore } from '@netlify/blobs';
import auth from '../lib/auth.js';

const { cabeceras, exigirAuth } = auth;

function objetoDeHeaders(req) {
  const out = {};
  req.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

export default async (req) => {
  const headers = objetoDeHeaders(req);
  const resp = cabeceras(headers);

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: resp });

  const rechazo = exigirAuth(headers, resp, 'direccion');
  if (rechazo) return json(JSON.parse(rechazo.body), rechazo.statusCode, resp);

  const store = getStore('notes');

  try {
    if (req.method === 'GET') {
      const { blobs } = await store.list();
      const notes = {};
      for (const blob of blobs) notes[blob.key] = await store.get(blob.key, { type: 'json' });
      return json(notes, 200, resp);
    }

    if (req.method === 'POST') {
      const { key, text, user } = await req.json();
      if (!key) return json({ error: 'key required' }, 400, resp);

      if (!text || !text.trim()) {
        await store.delete(key);
        return json({ deleted: true }, 200, resp);
      }

      const note = { text: text.trim(), user, updatedAt: new Date().toISOString() };
      await store.setJSON(key, note);
      return json(note, 200, resp);
    }

    return json({ error: 'Method not allowed' }, 405, resp);
  } catch (err) {
    return json({ error: err.message }, 500, resp);
  }
};
