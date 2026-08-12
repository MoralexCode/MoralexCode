/**
 * Convierte una línea cruda de log en un registro estructurado.
 *
 * Soporta dos formatos:
 *
 *   corchetes  el que usan hoy tus apps:
 *              [2026-08-08T02:51:49.624Z] [200]  info: Etiqueta | {json}
 *
 *   json       una línea = un objeto JSON (pino, winston con formato json)
 *
 * `auto` husmea las primeras líneas y decide.
 *
 * Nota sobre el formato `corchetes`: el número entre el segundo par de
 * corchetes NO es el status de la respuesta. En los logs reales vale 200
 * incluso en las líneas que reportan un 401, porque se captura antes de
 * que el manejador de error fije el código. El status de verdad viene
 * dentro del JSON (`statusCode`), y por eso el recolector nunca filtra
 * por ese corchete ni por el nivel.
 */

const RE_CORCHETES =
  /^\[(?<ts>[^\]]+)\]\s+\[(?<marca>[^\]]*)\]\s+(?<nivel>[A-Za-zÁÉÍÓÚáéíóú]+):\s*(?<cuerpo>.*)$/;

const RE_HTTP =
  /^(?<metodo>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\|\s*(?<auth>[^|]*?)\s*\|\s*"?(?<ruta>[^"|]*?)"?\s*$/;

const CLAVES_REQUEST_ID = [
  'requestId', 'request_id', 'reqId', 'req_id',
  'traceId', 'trace_id', 'correlationId', 'correlation_id',
];

const NIVELES_PINO = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
};

/** Extrae el primer objeto JSON completo que aparezca en el texto. */
function extraerJson(texto) {
  const inicio = texto.indexOf('{');
  if (inicio === -1) return null;

  // Busca la llave de cierre equilibrada, ignorando las que van dentro de
  // cadenas. Un indexOf('}') a secas se rompe con payloads anidados.
  let profundidad = 0;
  let enCadena = false;
  let escapado = false;

  for (let i = inicio; i < texto.length; i += 1) {
    const c = texto[i];

    if (escapado) { escapado = false; continue; }
    if (c === '\\') { escapado = true; continue; }
    if (c === '"') { enCadena = !enCadena; continue; }
    if (enCadena) continue;

    if (c === '{') profundidad += 1;
    else if (c === '}') {
      profundidad -= 1;
      if (profundidad === 0) {
        const bruto = texto.slice(inicio, i + 1);
        try {
          return { valor: JSON.parse(bruto), inicio, fin: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Busca un request id en el payload, hasta dos niveles de anidamiento. */
function hallarRequestId(payload) {
  if (!payload || typeof payload !== 'object') return null;

  for (const clave of CLAVES_REQUEST_ID) {
    const v = payload[clave];
    if (typeof v === 'string' && v) return v;
  }
  for (const valor of Object.values(payload)) {
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      for (const clave of CLAVES_REQUEST_ID) {
        const v = valor[clave];
        if (typeof v === 'string' && v) return v;
      }
    }
  }
  return null;
}

function aMilisegundos(valor) {
  if (valor == null) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const t = Date.parse(valor);
  return Number.isNaN(t) ? null : t;
}

function parsearCorchetes(linea) {
  const m = RE_CORCHETES.exec(linea);
  if (!m) return null;

  const { ts, marca, nivel, cuerpo } = m.groups;
  const limpio = cuerpo.trimEnd();

  const json = extraerJson(limpio);
  const payload = json?.valor ?? null;

  // Lo que queda antes del JSON es la etiqueta del evento
  // ("Usuario.login", "API.sendApiError", "Info"...).
  const cabeza = (json ? limpio.slice(0, json.inicio) : limpio).replace(/\s*\|\s*$/, '').trim();

  const http = RE_HTTP.exec(cabeza)?.groups ?? null;

  return {
    ts: aMilisegundos(ts),
    tsCrudo: ts,
    nivel: nivel.toLowerCase(),
    marca,
    etiqueta: http ? null : cabeza || null,
    http: http ? { metodo: http.metodo, auth: http.auth || null, ruta: http.ruta } : null,
    payload,
    requestId: hallarRequestId(payload),
    controlador: typeof payload?.controlador === 'string' ? payload.controlador : null,
  };
}

function parsearJson(linea) {
  let obj;
  try {
    obj = JSON.parse(linea);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const nivelCrudo = obj.level ?? obj.severity ?? 'info';
  const nivel =
    typeof nivelCrudo === 'number'
      ? (NIVELES_PINO[nivelCrudo] ?? String(nivelCrudo))
      : String(nivelCrudo).toLowerCase();

  const mensaje = obj.msg ?? obj.message ?? null;

  // El resto del objeto es el payload: se quitan los campos de transporte
  // que ya quedaron representados arriba.
  const payload = { ...obj };
  for (const k of ['time', 'timestamp', 'ts', '@timestamp', 'level', 'severity', 'msg', 'message', 'pid', 'hostname', 'v']) {
    delete payload[k];
  }

  const metodo = obj.req?.method ?? obj.method ?? null;
  const ruta = obj.req?.url ?? obj.url ?? obj.path ?? null;

  return {
    ts: aMilisegundos(obj.time ?? obj.timestamp ?? obj.ts ?? obj['@timestamp']),
    tsCrudo: String(obj.time ?? obj.timestamp ?? obj.ts ?? obj['@timestamp'] ?? ''),
    nivel,
    marca: String(obj.res?.statusCode ?? obj.statusCode ?? ''),
    etiqueta: mensaje ? String(mensaje) : null,
    http: metodo && ruta ? { metodo: String(metodo), auth: null, ruta: String(ruta) } : null,
    payload: Object.keys(payload).length ? payload : null,
    requestId: hallarRequestId(obj) ?? hallarRequestId(payload),
    controlador:
      typeof payload.controlador === 'string' ? payload.controlador
      : typeof payload.controller === 'string' ? payload.controller
      : null,
  };
}

/** Adivina el formato mirando unas cuantas líneas no vacías. */
export function detectarFormato(lineas) {
  let corchetes = 0;
  let json = 0;
  let vistas = 0;

  for (const linea of lineas) {
    if (!linea.trim()) continue;
    if (vistas >= 20) break;
    vistas += 1;
    if (RE_CORCHETES.test(linea)) corchetes += 1;
    else if (linea.trimStart().startsWith('{')) json += 1;
  }

  if (corchetes >= json && corchetes > 0) return 'corchetes';
  if (json > 0) return 'json';
  return 'corchetes';
}

/**
 * Parsea una línea. Devuelve siempre un registro: si no encaja con el
 * formato, se marca `reconocida: false` y se conserva el texto crudo,
 * porque una línea que no entendemos puede ser justo la interesante
 * (un stack trace suelto, por ejemplo).
 */
export function parsearLinea(linea, { formato, archivo, numero }) {
  const base = { archivo, numero, crudo: linea };

  const parseado = formato === 'json' ? parsearJson(linea) : parsearCorchetes(linea);

  if (!parseado) {
    return {
      ...base,
      reconocida: false,
      ts: null, tsCrudo: null, nivel: null, marca: null,
      etiqueta: null, http: null, payload: null,
      requestId: null, controlador: null,
      continuacion: /^\s+(at\s|Caused by|\.\.\.)/.test(linea),
    };
  }

  return { ...base, reconocida: true, continuacion: false, ...parseado };
}
