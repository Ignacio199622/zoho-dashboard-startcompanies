// El reporte de Matias en #sdr-virtual-matias (ver lib/matias-reporte.js).
// Corre en background: recorre todas las fichas `apertura-*` y relee en Zoho
// cada lead de los últimos 7 días.
import { getStore } from '@netlify/blobs';
import { publicar } from './lib/matias-reporte.js';
import { avisarFalla } from './lib/aviso-falla.js';

const CANDADO_MIN = 20;

export default async () => {
  const ahora = new Date();
  const store = getStore({ name: 'matias', consistency: 'strong' });
  // Candado: si el cron se dispara dos veces (reintento de Netlify), sale un solo reporte.
  const candado = await store.get('lock-reporte').catch(() => null);
  if (candado && ahora - new Date(candado) < CANDADO_MIN * 60e3) {
    console.log(`reporte matias: ya hay uno corriendo desde ${candado}, no se duplica`);
    return new Response('duplicado', { status: 200 });
  }
  await store.set('lock-reporte', ahora.toISOString());
  try {
    const f = await publicar(ahora);
    console.log(`reporte matias: ${f.abiertos.length} aperturas, ${f.contestaron.length} contestaron, ${f.agendaron.length} agendaron`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await store.delete('lock-reporte').catch(() => {});
    await avisarFalla('Matías (el reporte del SDR)', e, 'No salió el reporte de la mañana o de la tarde.');
    return new Response('fallo, avisado', { status: 200 });
  }
};
