const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const store = getStore('notes');

  try {
    if (event.httpMethod === 'GET') {
      // Get all notes
      const { blobs } = await store.list();
      const notes = {};
      for (const blob of blobs) {
        notes[blob.key] = await store.get(blob.key, { type: 'json' });
      }
      return { statusCode: 200, headers, body: JSON.stringify(notes) };
    }

    if (event.httpMethod === 'POST') {
      const { key, text, user } = JSON.parse(event.body);
      if (!key) return { statusCode: 400, headers, body: JSON.stringify({ error: 'key required' }) };

      if (!text || !text.trim()) {
        // Delete note if empty
        await store.delete(key);
        return { statusCode: 200, headers, body: JSON.stringify({ deleted: true }) };
      }

      const note = { text: text.trim(), user, updatedAt: new Date().toISOString() };
      await store.setJSON(key, note);
      return { statusCode: 200, headers, body: JSON.stringify(note) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
