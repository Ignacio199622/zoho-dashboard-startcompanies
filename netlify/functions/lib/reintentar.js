// Reintento con espera creciente.
//
// Sin esto, una corrida larga muere de a poco: 82 de 90 llamadas fallaron con
// "fetch failed" al disparar una atras de otra sin pausa ni reintento. No era
// la API rechazando, era la red cortando conexiones.

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {() => Promise<T>} fn
 * @param {{intentos?: number, esperaBase?: number, etiqueta?: string}} op
 */
export async function conReintento(fn, { intentos = 4, esperaBase = 1500, etiqueta = '' } = {}) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      const esUltimo = i === intentos - 1;
      if (esUltimo) break;
      // Si la API dijo cuanto esperar (un 429 con Retry-After), le hacemos
      // caso: reintentar a los 3 segundos contra una cuota solo la empeora.
      const espera = e?.reintentarEn
        ? e.reintentarEn * 1000 + Math.floor(Math.random() * 2000)
        : // Espera creciente con algo de ruido, para no reintentar todos a la vez.
          esperaBase * Math.pow(2, i) + Math.floor(Math.random() * 500);
      if (etiqueta) {
        process.stderr.write(`\n    reintento ${i + 1}/${intentos - 1} de ${etiqueta} en ${(espera / 1000).toFixed(1)}s (${String(e.message).slice(0, 60)})`);
      }
      await dormir(espera);
    }
  }
  throw ultimo;
}
