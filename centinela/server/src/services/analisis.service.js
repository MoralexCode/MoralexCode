import path from 'node:path';
import { env, RAIZ } from '../config/env.js';
import { buscar } from './log-collector.service.js';
import { detectarFormato, parsearLinea } from './log-parser.service.js';
import { reconstruir } from './request-reconstructor.service.js';
import { crearRedactor, renderizarBloque } from './log-sanitizer.service.js';
import { contarTokens, formatearBytes } from './token-counter.service.js';

const rel = (ruta) => path.relative(RAIZ, ruta) || ruta;

/**
 * Funde las líneas de todas las fuentes de la app en una sola secuencia
 * cronológica.
 *
 * Hace falta porque PM2 parte la salida en dos archivos: el `-out.log`
 * lleva el flujo normal y el `-error.log` el stack. Una petición fallida
 * deja media historia en cada uno, y leídos por separado ninguno cuenta el
 * error completo.
 *
 * Las líneas sin timestamp (continuaciones de un stack trace) se quedan
 * pegadas a la anterior en lugar de irse al principio.
 */
function fundirCronologicamente(bloques) {
  const registros = [];

  for (const bloque of bloques) {
    const textos = bloque.lineas.map((l) => l.texto);
    const formato =
      bloque.fuente.formato === 'auto' || !bloque.fuente.formato
        ? detectarFormato(textos)
        : bloque.fuente.formato;

    let tsPrevio = null;
    bloque.lineas.forEach((linea, orden) => {
      const registro = parsearLinea(linea.texto, {
        formato,
        archivo: bloque.fuente.ruta,
        numero: linea.numero,
      });
      if (registro.ts != null) tsPrevio = registro.ts;
      registros.push({ ...registro, tsOrden: registro.ts ?? tsPrevio, origen: bloque.fuente.origen, orden });
    });
  }

  return registros.sort((a, b) => {
    if (a.tsOrden != null && b.tsOrden != null && a.tsOrden !== b.tsOrden) return a.tsOrden - b.tsOrden;
    if (a.archivo !== b.archivo) return a.archivo < b.archivo ? -1 : 1;
    return a.numero - b.numero;
  });
}

function cabecera(campos) {
  const ancho = Math.max(...Object.keys(campos).map((k) => k.length));
  return Object.entries(campos)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k.padEnd(ancho)}  ${v}`)
    .join('\n');
}

/**
 * Analiza un request id de punta a punta: recolecta, reconstruye, limpia
 * y mide. No llama a ningún modelo — eso es la fase 2. Lo que devuelve es
 * exactamente el texto que se le mandaría.
 */
export async function analizarRequestId(app, requestId, opciones = {}) {
  const relacionadas = opciones.relacionadas ?? 0;
  const redactarPii = opciones.redactarPii ?? env.redactarPii;

  const recoleccion = await buscar(app, requestId, opciones);

  const bloques = recoleccion.resultados.map((r) => ({
    fuente: { ...r.fuente, formato: app.formato },
    lineas: r.lineas,
  }));

  const registros = fundirCronologicamente(bloques);
  const bytesCrudos = registros.reduce((n, r) => n + Buffer.byteLength(r.crudo, 'utf8') + 1, 0);

  const reconstruccion = reconstruir(registros, requestId, {
    ventanaMs: opciones.ventanaMs ?? env.ventanaMs,
    relacionadas,
  });

  const metricas = {
    lineasRecolectadas: registros.length,
    bytesCrudos,
    archivos: recoleccion.resultados.map((r) => rel(r.fuente.ruta)),
    notas: recoleccion.notas,
  };

  if (!reconstruccion.encontrado) {
    return { encontrado: false, motivo: reconstruccion.motivo, texto: null, metricas };
  }

  // El request id que buscamos no se redacta: es la referencia del usuario.
  const redactor = crearRedactor({ activo: redactarPii, preservar: [requestId] });

  const { peticion } = reconstruccion;
  const principal = renderizarBloque(peticion.lineas, redactor);

  const partes = [];

  partes.push(
    cabecera({
      app: `${app.nombre} (${app.id})`,
      petición: [peticion.metodo, peticion.ruta].filter(Boolean).join(' ') +
        (peticion.estado ? ` → ${peticion.estado}` : '') +
        (peticion.codigoError ? ` ${peticion.codigoError}` : ''),
      mensaje: peticion.mensaje ? `"${redactor.redactarTexto(peticion.mensaje)}"` : null,
      'request id': requestId,
      controlador: peticion.controlador,
      fuentes: metricas.archivos.join(', '),
      constantes: Object.entries(principal.constantes)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('  ') || null,
    }),
  );

  if (!reconstruccion.completa) {
    partes.push(`\n⚠ ${reconstruccion.motivo}`);
  }

  partes.push(`\npetición\n${principal.texto}`);

  if (reconstruccion.relacionadas.length > 0) {
    const trozos = reconstruccion.relacionadas.map((r, i) => {
      const { texto } = renderizarBloque(r.lineas, redactor, { sangria: '    ' });
      const cuando = r.entrada.tsCrudo ?? '(sin hora)';
      return `  [${i + 1}] ${cuando}\n${texto}`;
    });
    partes.push(
      `\npeticiones anteriores a la misma ruta (${reconstruccion.relacionadas.length})\n` +
        trozos.join('\n'),
    );
  }

  if (redactor.anomalias.length > 0) {
    const vistas = new Set();
    const lista = redactor.anomalias.filter((a) => {
      const clave = `${a.campo}|${a.detalle}`;
      if (vistas.has(clave)) return false;
      vistas.add(clave);
      return true;
    });
    partes.push(
      `\nanomalías en los datos (␣ marca cada espacio)\n` +
        lista.map((a) => `  · ${a.detalle}`).join('\n'),
    );
  }

  const descartadas = registros.length - peticion.lineas.length;
  if (descartadas > 0) {
    partes.push(
      `\ndescartado\n  ${descartadas} de ${registros.length} líneas recolectadas eran de otras peticiones concurrentes`,
    );
  }

  const texto = partes.join('\n');
  const bytesFinales = Buffer.byteLength(texto, 'utf8');
  const [crudos, finales] = await Promise.all([
    contarTokens(registros.map((r) => r.crudo).join('\n')),
    contarTokens(texto),
  ]);

  return {
    encontrado: true,
    texto,
    metricas: {
      ...metricas,
      lineasEnviadas: peticion.lineas.length,
      bytesFinales,
      tokensCrudos: crudos.tokens,
      tokensFinales: finales.tokens,
      tokensExactos: crudos.exacto && finales.exacto,
      reduccion: bytesCrudos > 0 ? bytesCrudos / bytesFinales : 1,
      dentroDelPresupuesto: finales.tokens <= env.tokenPresupuesto,
      anomalias: redactor.anomalias.length,
      valoresRedactados: redactor.mapa.size,
      formateado: {
        crudo: formatearBytes(bytesCrudos),
        final: formatearBytes(bytesFinales),
      },
    },
  };
}
