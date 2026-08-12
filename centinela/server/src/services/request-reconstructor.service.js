/**
 * Reconstruye una petición completa a partir de una sola línea.
 *
 * El problema que resuelve: en los logs reales el request id se estampa
 * únicamente en la línea del error (`API.sendApiError`). Las líneas que
 * cuentan la historia —la entrada HTTP, la búsqueda del usuario, el
 * resultado— no lo llevan. Y como el servidor atiende varias peticiones a
 * la vez, esas líneas vienen intercaladas con tráfico de otros usuarios:
 *
 *   02:51:49.554  POST | "/usuarios/login"        <- la petición empieza aquí
 *   02:51:49.554  Usuario.login | {...}
 *   02:51:47.112  GET  | "/productos/public"      <- otro usuario, estorba
 *   02:51:49.624  Usuario.validateUser | {...}
 *   02:51:49.624  API.sendApiError | {requestId}  <- la única con el id
 *
 * Tomar ±10 líneas a ciegas se lleva el ruido y a veces se pierde el
 * inicio. Aquí se hace al revés: se ancla en la línea del id, se busca
 * hacia atrás la entrada HTTP que coincide en método y ruta, y dentro de
 * ese tramo se conservan solo las líneas del mismo controlador.
 */

const norm = (ruta) => String(ruta || '').replace(/[?#].*$/, '').replace(/\/+$/, '');

/**
 * ¿La ruta concreta de la petición corresponde a este patrón de ruta?
 *
 * Compara segmento por segmento desde el final, porque la línea de entrada
 * registra la ruta montada (`/usuarios/login`) mientras que el error
 * registra la completa (`/api/v1/usuarios/login`). Los segmentos tipo
 * `:sku` casan con cualquier cosa.
 */
export function rutasCompatibles(concreta, patron) {
  const a = norm(concreta).split('/').filter(Boolean);
  const b = norm(patron).split('/').filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;

  const comunes = Math.min(a.length, b.length);
  for (let i = 1; i <= comunes; i += 1) {
    const segA = a[a.length - i];
    const segB = b[b.length - i];
    if (segB.startsWith(':') || segA.startsWith(':')) continue;
    if (segA !== segB) return false;
  }
  return true;
}

/** Datos de la petición que trae la línea del error. */
function leerAncla(registro) {
  const p = registro.payload ?? {};
  return {
    requestId: registro.requestId,
    metodo: p.httpMethod ?? p.method ?? registro.http?.metodo ?? null,
    ruta: p.path ?? p.url ?? registro.http?.ruta ?? null,
    estado: p.statusCode ?? p.status ?? null,
    codigoError: p.errorCode ?? p.code ?? null,
    mensaje: p.message ?? null,
  };
}

const esEntradaDe = (registro, metodo, ruta) =>
  registro.http != null &&
  (!metodo || registro.http.metodo === metodo) &&
  rutasCompatibles(ruta, registro.http.ruta);

/** ¿Esta línea reporta el desenlace de una petición a esta ruta? */
const esDesenlaceDe = (registro, ruta) => {
  const p = registro.payload;
  if (!p) return false;
  const suya = p.path ?? p.url;
  return typeof suya === 'string' && rutasCompatibles(suya, ruta);
};

/**
 * Reconstruye hacia adelante desde una línea de entrada HTTP.
 * Se usa para las peticiones relacionadas, que no tienen ancla propia.
 */
function reconstruirDesdeEntrada(registros, entradaIdx, { ventanaMs }) {
  const entrada = registros[entradaIdx];
  const ruta = entrada.http.ruta;
  const t0 = entrada.ts;

  const elegidas = [entrada];
  let controlador = null;

  for (let i = entradaIdx + 1; i < registros.length; i += 1) {
    const r = registros[i];
    if (t0 != null && r.ts != null && r.ts - t0 > ventanaMs) break;

    // Otra petición a la misma ruta: aquí acaba esta.
    if (esEntradaDe(r, entrada.http.metodo, ruta)) break;

    if (!controlador && r.controlador) controlador = r.controlador;

    if ((controlador && r.controlador === controlador) || esDesenlaceDe(r, ruta) || r.continuacion) {
      elegidas.push(r);
    }
  }

  return { entrada, lineas: elegidas, controlador };
}

/**
 * @param registros  líneas ya parseadas, ordenadas cronológicamente
 * @param requestId  el identificador que dio el usuario
 */
export function reconstruir(registros, requestId, { ventanaMs = 5000, relacionadas = 0 } = {}) {
  const anclaIdx = registros.findIndex((r) => r.requestId === requestId);

  if (anclaIdx === -1) {
    return {
      encontrado: false,
      motivo: `El request id ${requestId} no aparece en las líneas recolectadas.`,
      peticion: null,
      relacionadas: [],
    };
  }

  const ancla = registros[anclaIdx];
  const info = leerAncla(ancla);

  // Hacia atrás, dentro de la ventana, buscando dónde empezó la petición.
  let entradaIdx = -1;
  for (let i = anclaIdx - 1; i >= 0; i -= 1) {
    const r = registros[i];
    if (ancla.ts != null && r.ts != null && ancla.ts - r.ts > ventanaMs) break;
    if (info.ruta && esEntradaDe(r, info.metodo, info.ruta)) { entradaIdx = i; break; }
  }

  let lineas;
  let controlador = null;
  let completa = true;

  if (entradaIdx === -1) {
    // Sin entrada localizada solo queda la ventana temporal. Se marca,
    // porque el resultado trae ruido de otras peticiones y quien lo lea
    // —persona o modelo— debe saberlo.
    completa = false;
    lineas = registros.filter(
      (r) => ancla.ts == null || r.ts == null || Math.abs(ancla.ts - r.ts) <= ventanaMs,
    );
  } else {
    const tramo = registros.slice(entradaIdx, anclaIdx + 1);
    controlador = tramo.find((r) => r.controlador)?.controlador ?? null;

    lineas = tramo.filter(
      (r, i) =>
        i === 0 ||
        i === tramo.length - 1 ||
        r.continuacion ||
        (controlador != null && r.controlador === controlador) ||
        (info.ruta && esDesenlaceDe(r, info.ruta)),
    );
  }

  const resultado = {
    encontrado: true,
    completa,
    motivo: completa
      ? null
      : 'No se localizó la línea de entrada HTTP dentro de la ventana; se devuelve el rango por tiempo y puede traer líneas de otras peticiones.',
    peticion: { ...info, controlador, lineas, descartadas: registros.length - lineas.length },
    relacionadas: [],
  };

  if (relacionadas > 0 && info.ruta) {
    const limite = entradaIdx === -1 ? anclaIdx : entradaIdx;
    const previas = [];

    for (let i = limite - 1; i >= 0 && previas.length < relacionadas; i -= 1) {
      if (esEntradaDe(registros[i], info.metodo, info.ruta)) previas.push(i);
    }

    resultado.relacionadas = previas
      .reverse()
      .map((idx) => reconstruirDesdeEntrada(registros, idx, { ventanaMs }));
  }

  return resultado;
}
