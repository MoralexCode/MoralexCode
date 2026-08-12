import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { env } from '../config/env.js';

/**
 * Un patrón de búsqueda solo puede ser un identificador: letras, dígitos y
 * un puñado de separadores. Se valida ANTES de llegar a grep.
 *
 * Esto no sustituye a pasar los argumentos por arreglo (que es lo que de
 * verdad impide la inyección de comandos), es la segunda capa: evita que
 * alguien use el campo de búsqueda para hacer que grep barra el disco con
 * una expresión regular patológica.
 */
const RE_PATRON = /^[A-Za-z0-9._:@/-]{4,200}$/;

export function validarPatron(patron) {
  if (typeof patron !== 'string' || !RE_PATRON.test(patron)) {
    throw new Error(
      'Patrón de búsqueda inválido. Se permiten de 4 a 200 caracteres entre ' +
        'letras, dígitos y los signos . _ : @ / -',
    );
  }
  return patron;
}

const esComprimido = (ruta) => /\.gz$/i.test(ruta);

function flujoDeLineas(ruta) {
  const lectura = fs.createReadStream(ruta);
  const flujo = esComprimido(ruta) ? lectura.pipe(zlib.createGunzip()) : lectura;
  return readline.createInterface({ input: flujo, crlfDelay: Infinity });
}

/**
 * Devuelve los números de línea que contienen el patrón.
 *
 * En archivos planos delega a grep, que es órdenes de magnitud más rápido
 * que recorrerlos desde Node. Los comprimidos se recorren aquí mismo:
 * meter un `zcat | grep` implicaría un shell, y un shell es exactamente lo
 * que este servicio no quiere tener cerca de una entrada del usuario.
 */
function localizarConGrep(ruta, patron, { maxCoincidencias, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'grep',
      [
        '-n',                              // número de línea
        '-F',                              // cadena literal, no regex
        '-m', String(maxCoincidencias),
        '--binary-files=without-match',
        '--',                              // fin de opciones: un patrón que
        patron,                            //   empiece con "-" no es bandera
        ruta,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const numeros = [];
    let sobrante = '';
    let errores = '';
    let vencido = false;

    const reloj = setTimeout(() => {
      vencido = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (trozo) => {
      const texto = sobrante + trozo;
      const lineas = texto.split('\n');
      sobrante = lineas.pop() ?? '';
      for (const linea of lineas) {
        const corte = linea.indexOf(':');
        if (corte > 0) {
          const n = Number(linea.slice(0, corte));
          if (Number.isInteger(n)) numeros.push(n);
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (t) => { errores += t; });

    proc.on('error', (err) => {
      clearTimeout(reloj);
      reject(new Error(`No se pudo ejecutar grep: ${err.message}`));
    });

    proc.on('close', (codigo) => {
      clearTimeout(reloj);
      if (vencido) {
        return resolve({ numeros, truncado: true, motivo: `grep excedió ${timeoutMs} ms` });
      }
      // grep sale con 1 cuando no hubo coincidencias: no es un error.
      if (codigo !== 0 && codigo !== 1) {
        return reject(new Error(`grep terminó con código ${codigo}: ${errores.trim()}`));
      }
      resolve({ numeros, truncado: numeros.length >= maxCoincidencias, motivo: null });
    });
  });
}

async function localizarEnComprimido(ruta, patron, { maxCoincidencias }) {
  const numeros = [];
  let n = 0;
  for await (const linea of flujoDeLineas(ruta)) {
    n += 1;
    if (linea.includes(patron)) {
      numeros.push(n);
      if (numeros.length >= maxCoincidencias) return { numeros, truncado: true, motivo: null };
    }
  }
  return { numeros, truncado: false, motivo: null };
}

/** Une rangos que se traslapan para no leer dos veces las mismas líneas. */
function fusionarRangos(rangos) {
  if (rangos.length === 0) return [];
  const orden = [...rangos].sort((a, b) => a.desde - b.desde);
  const salida = [orden[0]];

  for (const r of orden.slice(1)) {
    const ultimo = salida[salida.length - 1];
    if (r.desde <= ultimo.hasta + 1) ultimo.hasta = Math.max(ultimo.hasta, r.hasta);
    else salida.push({ ...r });
  }
  return salida;
}

/** Lee de un archivo únicamente las líneas dentro de los rangos dados. */
async function leerRangos(ruta, rangos, { maxBytes }) {
  const lineas = [];
  let bytes = 0;
  let truncado = false;
  const ultimo = rangos[rangos.length - 1].hasta;

  let n = 0;
  for await (const texto of flujoDeLineas(ruta)) {
    n += 1;
    if (n > ultimo) break;

    if (rangos.some((r) => n >= r.desde && n <= r.hasta)) {
      bytes += Buffer.byteLength(texto, 'utf8') + 1;
      if (bytes > maxBytes) { truncado = true; break; }
      lineas.push({ numero: n, texto });
    }
  }
  return { lineas, bytes, truncado };
}

/**
 * Busca un patrón en todas las fuentes de una aplicación y devuelve las
 * líneas de contexto alrededor de cada coincidencia.
 *
 * El contexto es deliberadamente amplio (decenas de líneas): sirve de
 * materia prima para el reconstructor, que recorta después por semántica.
 * Recortar aquí a ±10 dejaría fuera el inicio de la petición cuando hay
 * tráfico concurrente de por medio.
 */
export async function buscar(app, patron, opciones = {}) {
  validarPatron(patron);

  const antes = opciones.antes ?? env.contextoAntes;
  const despues = opciones.despues ?? env.contextoDespues;
  const maxCoincidencias = opciones.maxCoincidencias ?? env.maxCoincidencias;
  const maxBytes = opciones.maxBytes ?? env.maxBytes;
  const timeoutMs = opciones.timeoutMs ?? env.timeoutMs;

  const resultados = [];
  const notas = [];
  let bytesTotales = 0;
  let coincidenciasTotales = 0;

  for (const fuente of app.fuentes) {
    const localizar = esComprimido(fuente.ruta) ? localizarEnComprimido : localizarConGrep;

    let hallazgo;
    try {
      hallazgo = await localizar(fuente.ruta, patron, { maxCoincidencias, timeoutMs });
    } catch (err) {
      notas.push(`${fuente.ruta}: ${err.message}`);
      continue;
    }

    if (hallazgo.motivo) notas.push(`${fuente.ruta}: ${hallazgo.motivo}`);
    if (hallazgo.numeros.length === 0) continue;

    coincidenciasTotales += hallazgo.numeros.length;

    const rangos = fusionarRangos(
      hallazgo.numeros.map((n) => ({ desde: Math.max(1, n - antes), hasta: n + despues })),
    );

    const { lineas, bytes, truncado } = await leerRangos(fuente.ruta, rangos, {
      maxBytes: maxBytes - bytesTotales,
    });
    bytesTotales += bytes;

    if (truncado) {
      notas.push(`${fuente.ruta}: se alcanzó el tope de ${maxBytes} bytes, la lectura quedó incompleta`);
    }

    resultados.push({
      fuente,
      lineas,
      coincidencias: hallazgo.numeros,
      truncado: truncado || hallazgo.truncado,
    });
  }

  return { patron, resultados, notas, bytes: bytesTotales, coincidencias: coincidenciasTotales };
}
