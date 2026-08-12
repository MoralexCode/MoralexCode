/**
 * Cuenta tokens para saber qué se está pagando antes de pagarlo.
 *
 * Usa js-tiktoken si está instalado (es dependencia opcional: si su
 * instalación falla, Centinela sigue funcionando). Si no está, cae a una
 * estimación calibrada sobre texto de logs en español, que mezcla prosa,
 * identificadores y JSON. La estimación se marca como tal en la salida:
 * un número aproximado presentado como exacto es peor que no tenerlo.
 */

// Se memoiza la promesa, no el resultado: dos llamadas concurrentes deben
// esperar a la misma carga. Guardar solo un booleano "ya lo intenté" hace
// que la segunda vea el codificador todavía en null y caiga al estimador
// aunque la biblioteca esté perfectamente instalada.
let carga = null;

function obtenerCodificador() {
  carga ??= import('js-tiktoken')
    .then(({ getEncoding }) => getEncoding('cl100k_base'))
    .catch(() => null);
  return carga;
}

export async function contarTokens(texto) {
  const enc = await obtenerCodificador();
  if (enc) return { tokens: enc.encode(texto).length, exacto: true };

  // Los logs traen muchos identificadores y puntuación, que se fragmentan
  // más que la prosa: ~3.3 caracteres por token en lugar de ~4.
  return { tokens: Math.ceil(texto.length / 3.3), exacto: false };
}

export function formatearBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
