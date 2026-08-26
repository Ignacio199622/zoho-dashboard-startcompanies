// Cerebro alternativo: Gemini.
//
// Existe porque la cuenta de Anthropic quedó desactivada y no queríamos que el
// agente dependiera de destrabarla. Cuando la cuenta vuelva, se cambia
// PROVEEDOR en config.js y esto queda de respaldo.
//
// La key sale de la configuración de los MCP que ya estaban instalados en la
// máquina, así que no hubo que pedir nada nuevo.
import { readFileSync } from 'node:fs';
import { env } from './entorno.js';

const CONFIG_CLAUDE = 'C:/Users/josei/.claude.json';

export function apiKey() {
  // En Netlify viene por variable de entorno. En la maquina, si no esta en el
  // .env, se cae a la configuracion de los MCP que ya la tenia.
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  try {
    const j = JSON.parse(readFileSync(CONFIG_CLAUDE, 'utf8'));
    const k =
      j.mcpServers?.gemini?.env?.GEMINI_API_KEY ||
      j.mcpServers?.veo?.env?.GEMINI_API_KEY ||
      j.mcpServers?.['nano-banana']?.env?.GEMINI_API_KEY;
    if (k) return k;
  } catch {}
  throw new Error('Falta GEMINI_API_KEY');
}

/**
 * El esquema de Gemini es OpenAPI, no JSON Schema: no acepta `type: [a, b]`
 * ni `additionalProperties`, y los opcionales se marcan con `nullable`.
 */
export function aEsquemaGemini(esquemaJsonSchema) {
  const conv = (n) => {
    if (Array.isArray(n.type)) {
      const tipos = n.type.filter((t) => t !== 'null');
      return { type: tipos[0].toUpperCase(), nullable: n.type.includes('null'), description: n.description };
    }
    if (n.type === 'object') {
      return {
        type: 'OBJECT',
        properties: Object.fromEntries(Object.entries(n.properties || {}).map(([k, v]) => [k, conv(v)])),
        required: n.required || [],
      };
    }
    if (n.type === 'array') return { type: 'ARRAY', items: conv(n.items), description: n.description };
    const base = { type: String(n.type).toUpperCase(), description: n.description };
    if (n.enum) base.enum = n.enum.filter((e) => e !== null);
    return base;
  };
  return conv(esquemaJsonSchema);
}

export async function generar({ modelo, instrucciones, contenido, esquema, maxTokens = 4000 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey()}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instrucciones }] },
      contents: [{ role: 'user', parts: [{ text: contenido }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: aEsquemaGemini(esquema),
        maxOutputTokens: maxTokens,
      },
    }),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);

  const cand = j.candidates?.[0];
  if (!cand) throw new Error(`Gemini sin candidatos: ${JSON.stringify(j).slice(0, 200)}`);
  // MAX_TOKENS deja el JSON cortado a la mitad: es un fallo, no un resultado.
  if (cand.finishReason && cand.finishReason !== 'STOP') {
    throw new Error(`Gemini corto la respuesta: ${cand.finishReason}`);
  }

  const texto = (cand.content?.parts || []).map((p) => p.text || '').join('');
  if (!texto.trim()) throw new Error('Gemini devolvió vacío');

  return {
    datos: JSON.parse(texto),
    uso: {
      entrada: j.usageMetadata?.promptTokenCount || 0,
      salida: j.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}
