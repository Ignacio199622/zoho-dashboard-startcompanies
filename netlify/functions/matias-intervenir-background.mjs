// La pasada diaria de "¿quién necesita una persona?" (ver lib/matias-intervenir.js).
// Va en background porque recorre las ~800 fichas del store y los hilos de cada una.
import { getStore } from '@netlify/blobs';
import { publicar } from './lib/matias-intervenir.js';
import { avisarFalla } from './lib/aviso-falla.js';

const CANDADO_MIN = 20;

export default async () => {
  const ahora = new Date();
  const store = getStore({ name: 'matias', consistency: 'strong' });
  // Mismo candado que el reporte: si Netlify reintenta el cron, sale un solo aviso.
  const candado = await store.get('lock-intervenir').catch(() => null);
  if (candado && ahora - new Date(candado) < CANDADO_MIN * 60e3) {
    console.log(`intervenir matias: ya hay uno corriendo desde ${candado}, no se duplica`);
    return new Response('duplicado', { status: 200 });
  }
  await store.set('lock-intervenir', ahora.toISOString());
  try {
    const r = await publicar(ahora);
    console.log(`intervenir matias: ${r.casos.length} casos, ${r.nuevos.length} avisados, ${r.repetidos.length} repetidos, mandado=${r.mandado}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    await store.delete('lock-intervenir').catch(() => {});
    await avisarFalla('Matías (los que necesitan una persona)', e, 'No salió el aviso diario a Santiago.');
    return new Response('fallo, avisado', { status: 200 });
  }
};
