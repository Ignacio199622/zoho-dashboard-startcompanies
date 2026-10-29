// Los seguimientos de Matias (ver lib/matias-seguimiento.js).
import { pasadaSeguimientos } from './lib/matias-seguimiento.js';
import { avisarFalla } from './lib/aviso-falla.js';

export default async () => {
  const enviar = process.env.MATIAS_ENVIAR === '1';
  try {
    const r = await pasadaSeguimientos({ enviar });
    console.log(`matias seguimiento (${enviar ? 'ENVIA' : 'sombra'}): revisados ${r.revisados}, seguidos ${r.seguidos}, cerrados ${r.cerrados}${r.motivo ? `, ${r.motivo}` : ''}${r.cuidadoEnEspera ? `, en espera por cuidado ${r.cuidadoEnEspera}` : ''}${Object.keys(r.cuidado || {}).length ? `, cupo cuidado ${JSON.stringify(r.cuidado)}` : ''}${r.fusible?.length ? `, fusible ${r.fusible.join("/")}` : ''}`);
    for (const s of r.salteados) console.log(`  salteado: ${s}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await avisarFalla('Matías (los seguimientos del SDR)', e, 'Los leads abiertos no reciben el seguimiento.');
    return new Response('fallo, avisado', { status: 200 });
  }
};
