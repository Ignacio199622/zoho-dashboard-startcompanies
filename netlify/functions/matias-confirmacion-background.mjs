// Matias y las reuniones sin confirmar (ver lib/matias-confirmacion.js).
import { pasadaConfirmacion } from './lib/matias-confirmacion.js';
import { avisarFalla } from './lib/aviso-falla.js';

export default async () => {
  const enviar = process.env.MATIAS_CONFIRMACION_ENVIAR === '1';
  try {
    const r = await pasadaConfirmacion({ enviar });
    console.log(`matias confirmacion (${enviar ? 'ENVIA' : 'sombra'}): vistos ${r.vistos}, tocados ${r.tocados}, propuestos ${r.propuestos}${r.motivo ? `, ${r.motivo}` : ''}`);
    for (const s of r.salteados) console.log(`  salteado: ${s}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await avisarFalla('Matías (la confirmación del SDR)', e, 'Las reuniones sin confirmar no reciben el toque de Matías.');
    return new Response('fallo, avisado', { status: 200 });
  }
};
