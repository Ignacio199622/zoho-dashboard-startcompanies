// Matias y el que no entro a la asesoria (ver lib/matias-noshow.js).
import { pasadaNoShow } from './lib/matias-noshow.js';
import { avisarFalla } from './lib/aviso-falla.js';

export default async (req) => {
  // Mismo interruptor que todo Matías (Ignacio, 16-sep: "los no-show también"); MATIAS_NOSHOW_ENVIAR=0 lo apaga solo a él.
  const enviar = process.env.MATIAS_ENVIAR === '1' && process.env.MATIAS_NOSHOW_ENVIAR !== '0';
  // Una pasada a mano con ventana más larga para las canceladas (?horas_canceladas=200): la de
  // ponerse al día con los liberados del 6 al 11-oct. El reloj no lo manda: sigue en 48 h. Tope 10 días.
  const pedido = Number(new URL(req.url).searchParams.get('horas_canceladas'));
  const horasCanceladas = pedido > 0 ? Math.min(pedido, 240) : undefined;
  try {
    const r = await pasadaNoShow({ enviar, horasCanceladas });
    console.log(`matias no-show (${enviar ? 'ENVIA' : 'sombra'}): vistos ${r.vistos}, tocados ${r.tocados}, propuestos ${r.propuestos}${r.motivo ? `, ${r.motivo}` : ''}`);
    for (const s of r.salteados) console.log(`  salteado: ${s}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await avisarFalla('Matías (el no-show del SDR)', e, 'Los que no entraron a la asesoría no reciben el mensaje de Matías.');
    return new Response('fallo, avisado', { status: 200 });
  }
};
