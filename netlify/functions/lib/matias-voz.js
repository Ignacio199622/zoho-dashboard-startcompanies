/*
 * LAS NOTAS DE VOZ DE MATÍAS (Ignacio, 14-sep-2026: "meteleee algo piola").
 *
 * Cuando el lead ya le escribió (ventana de 24 h abierta), Matías puede
 * contestar con un audio en vez de texto: ElevenLabs genera la voz (la misma
 * receta de los audios de ManyChat: eleven_v3, etiqueta de acento al inicio,
 * "yo" → "sho"), el mp3 se sube a Meta y sale como mensaje de audio.
 *
 * Cuándo va en audio y cuándo no (`conviene`): texto corto, conversacional,
 * sin link ni lista de horarios (eso se lee mejor escrito). Si ElevenLabs o
 * Meta fallan, sale el texto: el audio nunca deja al lead sin respuesta.
 *
 * Se prende con MATIAS_VOZ=1; la voz con MATIAS_VOZ_ID (id de ElevenLabs).
 */
import { env } from './entorno.js';
import { lineaDe, mandar } from './matias.js';

const ETIQUETA = '[acento argentino rioplatense, hablando relajado como en un audio de WhatsApp] ';
const VOZ_POR_DEFECTO = 'cjVigY5qzO86Huf0OWal'; // "Eric" de ElevenLabs, hasta que Ignacio elija

export const activa = () => env.MATIAS_VOZ === '1' && Boolean(env.ELEVENLABS_API_KEY);

/** ¿Este texto queda mejor como audio? Corto, sin link, sin lista de horarios, sin mail. */
export function conviene(texto) {
  const t = String(texto || '');
  if (!t || t.length > 450) return false;
  if (/https?:\/\//.test(t)) return false;
  if (/\d{1,2}:\d{2}/.test(t)) return false; // horarios: mejor escritos, el lead los relee
  if (/@/.test(t)) return false;
  return true;
}

/** Lo que se le manda a leer: etiqueta de acento, "yo" → "sho", siglas y símbolos habladas. */
export function paraLeer(texto) {
  return ETIQUETA + String(texto)
    .replace(/\byo\b/gi, 'sho')
    .replace(/\bUSD\b/g, 'dólares')
    .replace(/\bLLCs\b/g, 'ele ele ces')
    .replace(/\bLLC\b/g, 'ele ele ce')
    .replace(/\bEE\.?\s?UU\.?/g, 'Estados Unidos')
    .replace(/\s*\n+\s*/g, '. ');
}

async function generar(texto) {
  const voz = env.MATIAS_VOZ_ID || VOZ_POR_DEFECTO;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voz}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: paraLeer(texto), model_id: 'eleven_v3', voice_settings: { stability: 0.4, similarity_boost: 0.9, style: 0.35, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function subirAMeta(mp3, linea) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/mpeg');
  form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'matias.mp3');
  const r = await fetch(`https://graph.facebook.com/v21.0/${linea}/media`, { method: 'POST', headers: { Authorization: `Bearer ${env.META_WHATSAPP_TOKEN}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`Meta media ${r.status}: ${JSON.stringify(j.error || j).slice(0, 150)}`);
  return j.id;
}

/** Genera y manda la nota de voz. Devuelve el id del mensaje de Meta. Tira si algo falla. */
export async function enviarNotaDeVoz(numero, texto) {
  const mp3 = await generar(texto);
  // El media es de un número: se sube y se manda por la misma línea (la del lead).
  const linea = await lineaDe(numero);
  const mediaId = await subirAMeta(mp3, linea);
  const id = await mandar(numero, { type: 'audio', audio: { id: mediaId } }, { linea });
  return { id, bytes: mp3.length };
}
