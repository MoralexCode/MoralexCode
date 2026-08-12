import fs from 'node:fs';
import path from 'node:path';
import { RAIZ } from './env.js';

const FORMATOS = new Set(['corchetes', 'json', 'auto']);
const RE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Expande una entrada de ruta del .env a archivos reales.
 *
 * Acepta varias rutas separadas por coma y un comodín `*` en el nombre
 * del archivo (no en los directorios), que es la forma que toman los
 * rotados de pm2-logrotate: `app-out__2026-08-12_00-00-00.log`.
 *
 * Los comodines se resuelven con un readdir acotado al directorio, no
 * con un glob recursivo: el registro debe apuntar a rutas conocidas, no
 * barrer el disco.
 */
function expandirRutas(entrada, { etiqueta }) {
  if (!entrada || !entrada.trim()) return [];

  const resultado = [];

  for (const trozo of entrada.split(',')) {
    const crudo = trozo.trim();
    if (!crudo) continue;

    const absoluta = path.isAbsolute(crudo) ? crudo : path.resolve(RAIZ, crudo);
    const base = path.basename(absoluta);

    if (!base.includes('*')) {
      resultado.push(absoluta);
      continue;
    }

    const directorio = path.dirname(absoluta);
    if (directorio.includes('*')) {
      throw new Error(
        `${etiqueta}: el comodín solo se permite en el nombre del archivo, no en el directorio ("${crudo}")`,
      );
    }

    const patron = new RegExp(
      `^${base.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
    );

    let entradas;
    try {
      entradas = fs.readdirSync(directorio, { withFileTypes: true });
    } catch (err) {
      throw new Error(`${etiqueta}: no se pudo leer el directorio ${directorio} (${err.code})`);
    }

    for (const dirent of entradas) {
      if (dirent.isDirectory()) continue;
      if (patron.test(dirent.name)) resultado.push(path.join(directorio, dirent.name));
    }
  }

  // Los rotados llevan la fecha en el nombre, así que el orden alfabético
  // inverso deja primero el más reciente.
  return [...new Set(resultado)].sort().reverse();
}

/** Verifica que el archivo exista y sea legible, sin abrirlo del todo. */
function revisarArchivo(ruta) {
  try {
    const st = fs.statSync(ruta);
    if (!st.isFile()) return { ruta, ok: false, motivo: 'no es un archivo' };
    fs.accessSync(ruta, fs.constants.R_OK);
    return { ruta, ok: true, bytes: st.size, modificado: st.mtime };
  } catch (err) {
    const motivo = err.code === 'ENOENT' ? 'no existe' : err.code === 'EACCES' ? 'sin permiso de lectura' : err.code;
    return { ruta, ok: false, motivo };
  }
}

/**
 * Lee los bloques APP_<N>_* del entorno y arma el catálogo de aplicaciones.
 *
 * Falla ruidosamente ante una configuración inválida: es preferible no
 * arrancar a arrancar apuntando a rutas que no existen y devolver
 * "no encontré nada" cuando en realidad nunca se buscó.
 */
export function cargarRegistro({ estricto = true } = {}) {
  const apps = [];
  const avisos = [];

  for (let n = 1; ; n += 1) {
    const id = process.env[`APP_${n}_ID`];
    if (!id) break;

    const etiqueta = `APP_${n}`;

    if (!RE_ID.test(id)) {
      throw new Error(`${etiqueta}_ID inválido ("${id}"): usa letras, números, punto, guion o guion bajo.`);
    }
    if (apps.some((a) => a.id === id)) {
      throw new Error(`${etiqueta}_ID duplicado ("${id}"): cada aplicación necesita un id único.`);
    }

    const formato = (process.env[`APP_${n}_LOG_FORMAT`] || 'auto').trim().toLowerCase();
    if (!FORMATOS.has(formato)) {
      throw new Error(
        `${etiqueta}_LOG_FORMAT inválido ("${formato}"): usa ${[...FORMATOS].join(', ')}.`,
      );
    }

    const fuentes = [];
    for (const [clave, origen] of [
      ['LOG_OUT', 'stdout'],
      ['LOG_ERR', 'stderr'],
      ['LOG_APP', 'app'],
    ]) {
      for (const ruta of expandirRutas(process.env[`APP_${n}_${clave}`], {
        etiqueta: `${etiqueta}_${clave}`,
      })) {
        fuentes.push({ ...revisarArchivo(ruta), origen });
      }
    }

    if (fuentes.length === 0) {
      throw new Error(
        `${etiqueta} ("${id}") no tiene ninguna ruta de log configurada. ` +
          `Llena al menos ${etiqueta}_LOG_OUT.`,
      );
    }

    for (const f of fuentes.filter((x) => !x.ok)) {
      const msg = `${etiqueta} ("${id}"): ${f.ruta} — ${f.motivo}`;
      if (estricto) throw new Error(msg);
      avisos.push(msg);
    }

    apps.push({
      id,
      nombre: process.env[`APP_${n}_NAME`] || id,
      formato,
      dbUrl: process.env[`APP_${n}_DB_URL`] || null,
      fuentes: fuentes.filter((f) => f.ok),
    });
  }

  return { apps, avisos };
}

export function buscarApp(registro, id) {
  const app = registro.apps.find((a) => a.id === id);
  if (app) return app;

  const disponibles = registro.apps.map((a) => a.id).join(', ') || '(ninguna)';
  throw new Error(`No hay una aplicación con id "${id}". Registradas: ${disponibles}`);
}
