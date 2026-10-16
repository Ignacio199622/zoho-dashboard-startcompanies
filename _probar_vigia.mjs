// Prueba local del vigia con datos reales, SOLO LECTURA y SIN Slack.
//
// No pide token de Zoho: reusa el compartido del store `zoho-token` que ya
// tienen los agentes (se baja antes con la CLI a un archivo). Si esta vencido
// o hay pausa vigente, el bloque WhatsApp no corre: nunca se pide uno nuevo.
//
//   netlify blobs:get control-crm bitacora > DIR/bitacora.json
//   netlify blobs:get zoho-token actual   > DIR/token.json
//   netlify blobs:get zoho-token pausa    > DIR/pausa.json
//   node _probar_vigia.mjs DIR SALIDA.md
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { juntar, texto, fotoDelDia } from './netlify/functions/lib/vigia/informe.js';
import { armarSemanal } from './netlify/functions/lib/vigia/semanal.js';

const [dir, salida] = process.argv.slice(2);
const leer = (f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };

const bitacoraCrm = leer('bitacora.json');
const tok = leer('token.json');
const pausa = leer('pausa.json');

let get;
const guardadas = leer('convs.json');
if (guardadas) {
  // Ya se leyo Zoho en una prueba anterior: se reusa, cero llamadas.
  get = async () => guardadas;
} else if (pausa?.hasta && Date.now() < pausa.hasta) {
  console.log('Zoho en pausa compartida: WhatsApp apagado en esta prueba.');
  process.env.VIGIA_WHATSAPP = '0';
} else if (!tok?.valor || Date.now() > tok.venceEn - 60e3) {
  console.log('El token compartido esta vencido: WhatsApp apagado en esta prueba (no se pide uno nuevo).');
  process.env.VIGIA_WHATSAPP = '0';
} else {
  let llamadas = 0;
  get = async (path, cabeceras = {}) => {
    if (++llamadas > 1) throw new Error('el vigia intento una segunda llamada a Zoho');
    const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${tok.valor}`, ...cabeceras } });
    if (r.status === 204 || r.status === 304) return { data: [], info: {} };
    const j = await r.json();
    if (j.status === 'error') throw new Error(`Zoho ${j.code} ${j.message}`);
    writeFileSync(join(dir, 'convs.json'), JSON.stringify(j));
    return j;
  };
}

const ahora = new Date();
const r = await juntar({ ahora, desde: new Date(ahora - 12 * 36e5), get, bitacoraCrm });
const t = texto(r);
console.log(t);
console.log(`\n[leidas=${r.wa?.leidas ?? '-'} esperando=${r.wa?.pendientes?.length ?? '-'} analizados=${r.wa?.analizados ?? '-'} errores=${JSON.stringify(r.errores)}]`);

// El semanal con lo que hay: la foto de esta corrida (en Netlify serian las
// de toda la semana, del store `vigia`) + 7 dias reales de Control CRM.
const sem = await armarSemanal({ corridas: [fotoDelDia(r)], bitacoraCrm, ahora });
console.log('\n' + sem.texto);
if (salida) writeFileSync(salida, `## Diario (real)\n\n${t}\n\n## Semanal (real: 1 informe diario + 7 días de Control CRM)\n\n${sem.texto}\n`);
