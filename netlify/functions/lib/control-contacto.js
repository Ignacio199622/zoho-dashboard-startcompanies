/*
 * Control de contacto de los leads de Panel gratis (Ignacio, 14-oct-2026: "necesito un
 * control de si se lo contactó o no").
 *
 * El aviso "LLAMAR…" sale por la línea de Matías al WhatsApp de admin (+1 786 825 0365)
 * con un CÓDIGO: los últimos 5 dígitos del id del lead (lo arma lead-landing.mjs en
 * referidos). Quien lo llama responde ese chat con el código y cómo le fue. La respuesta
 * llega a este webhook (es la línea de Matías) y acá:
 *   1. NUNCA pasa a Matías: el admin no es un lead.
 *   2. Se busca el lead por el código y se le deja una nota "CONTACTADO" con el texto.
 *   3. Se le confirma al admin por el mismo chat.
 * La alerta por los que nadie respondió la manda referidos/control-contacto.mjs, que lee
 * esas notas (el mail del equipo vive allá).
 */
import { get } from './conversaciones/zoho.js';
import { agregarNota } from './escribir.js';
import { enviarTexto } from './matias.js';

const EQUIPO = new Set(String(process.env.CONTROL_CONTACTO_WA || '17868250365').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean));
export const esDelEquipo = (numero) => EQUIPO.has(String(numero || '').replace(/\D/g, ''));

export const TITULO_CONTACTADO = 'CONTACTADO (aviso WhatsApp admin)';
const DIAS = 4;

/** Leads de Panel gratis que reciben aviso: con LLC, o sin LLC que no están solo averiguando. */
export function califica(lead) {
  const tags = (lead.Tag || []).map((t) => t.name);
  if (tags.includes('Form Panel Gratis')) return true;
  return tags.includes('Panel Gratis Sin LLC') && lead.Lead_Status !== 'Nurturing';
}

async function recientes() {
  const j = await get(`Leads?fields=Full_Name,Mobile,Lead_Status,Tag,Created_Time,Lead_Source&sort_by=Created_Time&sort_order=desc&per_page=100`);
  const desde = Date.now() - DIAS * 864e5;
  return (j.data || []).filter((l) => new Date(l.Created_Time).getTime() >= desde && califica(l));
}

async function yaContactado(id) {
  const j = await get(`Leads/${id}/Notes?fields=Note_Title,Created_Time&per_page=50`);
  return (j.data || []).some((n) => String(n.Note_Title || '').startsWith('CONTACTADO'));
}

const fechaAR = (d = new Date()) => new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' (AR)';

/** Respuesta del WhatsApp de admin a un aviso. `linea` = la línea de Matías por la que entró. */
export async function registrarRespuesta(m, linea) {
  const responder = (txt) => enviarTexto(m.de, txt, { linea, humano: true }).catch((e) => console.log('control-contacto: no se pudo responder', e.message));
  const leads = await recientes();
  const codigos = String(m.texto).match(/\b\d{5}\b/g) || [];
  let elegidos = leads.filter((l) => codigos.some((c) => String(l.id).endsWith(c)));

  if (!elegidos.length) {
    // Sin código: si hay un solo pendiente se asume ese; si no, se pregunta.
    const pendientes = [];
    for (const l of leads) if (!(await yaContactado(l.id))) pendientes.push(l);
    if (pendientes.length === 1 && !codigos.length) elegidos = pendientes;
    else {
      const lista = pendientes.slice(0, 8).map((l) => `${String(l.id).slice(-5)} · ${l.Full_Name}`).join('\n');
      await responder(codigos.length
        ? `No encontré ningún lead de Panel gratis con el código ${codigos.join(', ')}. Pendientes:\n${lista || '(ninguno)'}`
        : `¿De cuál lead es? Respondé con el código y cómo te fue. Pendientes:\n${lista || '(ninguno)'}`);
      console.log(`control-contacto: respuesta sin lead claro (${codigos.join(',') || 'sin código'})`);
      return;
    }
  }

  for (const l of elegidos) {
    await agregarNota(l.id, TITULO_CONTACTADO, `${fechaAR(m.cuando)}, respondido desde el WhatsApp de admin:\n${m.texto}`);
    console.log(`control-contacto: ${l.id} ${l.Full_Name} marcado contactado`);
  }
  await responder(`✅ Anotado en Zoho: ${elegidos.map((l) => l.Full_Name).join(', ')} contactado. Gracias!`);
}
