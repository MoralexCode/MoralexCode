/**
 * Reduce y limpia lo recolectado antes de que salga del servidor.
 *
 * Un principio manda sobre todos los demás: **la redacción no puede
 * destruir la señal**. En un caso real de este mismo proyecto, el motivo
 * del fallo era que el correo llegaba con un espacio al final:
 *
 *     {"email":"mariana.reyes@correo.com "}   -> found:false
 *     {"email":"mariana.reyes@correo.com"}    -> found:true
 *
 * Sustituir a ciegas por `<EMAIL_1>` borra exactamente el dato que explica
 * el error. Por eso el redactor conserva los espacios de más marcándolos
 * con ␣ y además los reporta aparte como anomalía.
 */

const MARCA_ESPACIO = '␣';

const PATRONES = [
  { tipo: 'JWT',    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  { tipo: 'EMAIL',  re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g },
  { tipo: 'IP',     re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { tipo: 'OID',    re: /\b[a-f0-9]{24}\b/g },
  { tipo: 'TEL',    re: /\b(?:\+?52[\s-]?)?(?:\(?\d{2,3}\)?[\s-]?)\d{3,4}[\s-]?\d{4}\b/g },
];

const CLAVES_SECRETAS =
  /^(pass(word)?|contrase(n|ñ)a|secret|token|api[_-]?key|authorization|auth|cookie|refresh[_-]?token)$/i;

/** Valida un número de tarjeta antes de redactarlo, para no comerse timestamps. */
function esTarjeta(digitos) {
  if (digitos.length < 13 || digitos.length > 19) return false;
  let suma = 0;
  let doble = false;
  for (let i = digitos.length - 1; i >= 0; i -= 1) {
    let d = Number(digitos[i]);
    if (doble) { d *= 2; if (d > 9) d -= 9; }
    suma += d;
    doble = !doble;
  }
  return suma % 10 === 0;
}

export function crearRedactor({ activo = true, preservar = [] } = {}) {
  const mapa = new Map();      // valor original -> marcador
  const contadores = new Map(); // tipo -> siguiente número
  const intactos = new Set(preservar.filter(Boolean));
  const anomalias = [];

  const marcador = (tipo, valor) => {
    if (mapa.has(valor)) return mapa.get(valor);
    const n = (contadores.get(tipo) ?? 0) + 1;
    contadores.set(tipo, n);
    const m = `<${tipo}_${n}>`;
    mapa.set(valor, m);
    return m;
  };

  /** Redacta texto libre (líneas crudas, mensajes). */
  const redactarTexto = (texto) => {
    if (!activo || typeof texto !== 'string') return texto;
    let salida = texto;

    for (const { tipo, re } of PATRONES) {
      salida = salida.replace(re, (coincidencia) =>
        intactos.has(coincidencia) ? coincidencia : marcador(tipo, coincidencia),
      );
    }

    salida = salida.replace(/\b(?:\d[ -]?){13,19}\b/g, (c) =>
      esTarjeta(c.replace(/\D/g, '')) ? marcador('TARJETA', c) : c,
    );

    return salida;
  };

  /**
   * Redacta el valor de un campo conservando los espacios sobrantes.
   * `ruta` es la ruta del campo dentro del payload, para poder reportarla.
   */
  const redactarValor = (valor, ruta) => {
    if (typeof valor !== 'string') return valor;

    const nucleo = valor.trim();
    const izq = valor.length - valor.trimStart().length;
    const der = valor.length - valor.trimEnd().length;

    if (izq > 0 || der > 0) {
      anomalias.push({
        campo: ruta,
        tipo: 'espacios',
        detalle:
          `el valor de "${ruta}" trae ${izq > 0 ? `${izq} espacio(s) al inicio` : ''}` +
          `${izq > 0 && der > 0 ? ' y ' : ''}` +
          `${der > 0 ? `${der} espacio(s) al final` : ''}`,
      });
    }

    if (nucleo === '') {
      anomalias.push({ campo: ruta, tipo: 'vacio', detalle: `el valor de "${ruta}" está vacío` });
    }

    const redactado = activo ? redactarTexto(nucleo) : nucleo;
    return MARCA_ESPACIO.repeat(izq) + redactado + MARCA_ESPACIO.repeat(der);
  };

  /** Recorre un payload redactando strings y ocultando claves sensibles. */
  const redactarPayload = (valor, ruta = '') => {
    if (valor === null || valor === undefined) return valor;

    if (Array.isArray(valor)) {
      return valor.map((v, i) => redactarPayload(v, ruta ? `${ruta}[${i}]` : `[${i}]`));
    }

    if (typeof valor === 'object') {
      const salida = {};
      for (const [clave, v] of Object.entries(valor)) {
        const sub = ruta ? `${ruta}.${clave}` : clave;
        salida[clave] = CLAVES_SECRETAS.test(clave) ? '<SECRETO>' : redactarPayload(v, sub);
      }
      return salida;
    }

    if (typeof valor === 'string') return redactarValor(valor, ruta || '(raíz)');
    return valor;
  };

  return { redactarTexto, redactarValor, redactarPayload, anomalias, mapa };
}

// ---------------------------------------------------------------------------
//  Presentación
// ---------------------------------------------------------------------------

// Campos que ya viajan en la cabecera del reporte: repetirlos en cada
// línea es pagar tokens dos veces por el mismo dato.
const CAMPOS_RUIDO = new Set([
  'controlador', 'controller', 'requestId', 'request_id',
  'httpMethod', 'path', 'message',
]);

function formatearValor(valor) {
  if (typeof valor === 'string') return valor;
  if (valor === null) return 'null';
  if (typeof valor === 'object') return JSON.stringify(valor);
  return String(valor);
}

/** Aplana un payload a pares `clave=valor`, tirando contenedores vacíos. */
function aParejas(payload, omitir) {
  if (!payload || typeof payload !== 'object') return [];

  return Object.entries(payload)
    .filter(([clave, valor]) => {
      if (omitir.has(clave)) return false;
      if (valor && typeof valor === 'object' && Object.keys(valor).length === 0) return false;
      return true;
    })
    .map(([clave, valor]) => `${clave}=${formatearValor(valor)}`);
}

/**
 * Renderiza un bloque de líneas ya reconstruido.
 *
 * Dos ahorros que se notan: los campos con el mismo valor en todas las
 * líneas se izan a la cabecera y desaparecen de cada línea, y los
 * timestamps absolutos se vuelven deltas contra el primero.
 */
export function renderizarBloque(lineas, redactor, { sangria = '  ' } = {}) {
  if (lineas.length === 0) return { texto: '', constantes: {} };

  const t0 = lineas.find((l) => l.ts != null)?.ts ?? null;

  const preparadas = lineas.map((l) => ({
    original: l,
    payload: l.payload ? redactor.redactarPayload(l.payload) : null,
  }));

  // Campos constantes en todo el bloque -> se izan a la cabecera.
  const constantes = {};
  const conPayload = preparadas.filter((p) => p.payload);
  if (conPayload.length > 1) {
    for (const clave of Object.keys(conPayload[0].payload)) {
      const valores = conPayload.map((p) => JSON.stringify(p.payload?.[clave]));
      if (valores.every((v) => v !== undefined && v === valores[0]) && conPayload.length === preparadas.filter((p) => p.payload).length) {
        constantes[clave] = conPayload[0].payload[clave];
      }
    }
  }

  const omitir = new Set([...Object.keys(constantes), ...CAMPOS_RUIDO]);

  const renglones = [];
  for (const { original, payload } of preparadas) {
    const delta =
      original.ts != null && t0 != null
        ? `+${String(original.ts - t0).padStart(5)}ms`
        : '       —';

    let cuerpo;
    if (original.http) {
      const auth = original.http.auth ? ` (${original.http.auth.toLowerCase()})` : '';
      cuerpo = `${original.http.metodo} ${original.http.ruta}${auth}`;
    } else if (original.reconocida) {
      const parejas = aParejas(payload, omitir);
      cuerpo = [original.etiqueta, parejas.join('  ')].filter(Boolean).join('  ');
    } else {
      cuerpo = redactor.redactarTexto(original.crudo.trim());
    }

    renglones.push(`${sangria}${delta}  ${cuerpo}`);
  }

  // Colapsa renglones idénticos consecutivos (ignorando el delta).
  const colapsados = [];
  for (const renglon of renglones) {
    const cuerpo = renglon.slice(sangria.length + 10);
    const ultimo = colapsados[colapsados.length - 1];
    if (ultimo && ultimo.cuerpo === cuerpo) { ultimo.veces += 1; continue; }
    colapsados.push({ renglon, cuerpo, veces: 1 });
  }

  const texto = colapsados
    .map(({ renglon, veces }) => (veces > 1 ? `${renglon}  (×${veces})` : renglon))
    .join('\n');

  return { texto, constantes };
}
