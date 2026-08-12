#!/usr/bin/env node
/**
 * Genera los bloques APP_<N>_* del .env leyendo la configuración de PM2.
 *
 * PM2 ya sabe dónde escribe cada aplicación (`pm2_env.pm_out_log_path` y
 * `pm_err_log_path`), así que no tiene sentido teclear esas rutas a mano
 * ni arriesgarse a que se desincronicen cuando muevas una app.
 *
 * El .env sigue siendo la única fuente de verdad: Centinela nunca consulta
 * a PM2 en caliente. Este script solo imprime el texto para que lo pegues,
 * y no modifica ningún archivo.
 *
 *   npm run descubrir:pm2 >> .env
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function pm2Jlist() {
  return new Promise((resolve, reject) => {
    const proc = spawn('pm2', ['jlist'], { stdio: ['ignore', 'pipe', 'pipe'] });

    let salida = '';
    let errores = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (t) => { salida += t; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (t) => { errores += t; });

    proc.on('error', (err) => {
      reject(
        err.code === 'ENOENT'
          ? new Error('No encontré el comando pm2 en este equipo. Corre esto en el servidor donde viven las apps.')
          : err,
      );
    });

    proc.on('close', (codigo) => {
      if (codigo !== 0) return reject(new Error(`pm2 jlist terminó con código ${codigo}: ${errores.trim()}`));
      try {
        resolve(JSON.parse(salida));
      } catch {
        reject(new Error('pm2 jlist no devolvió JSON válido.'));
      }
    });
  });
}

/** Busca un log propio de la app junto a su directorio de trabajo. */
function logDeLaApp(cwd, nombre) {
  if (!cwd) return '';
  for (const candidato of [
    path.join(cwd, 'logs', `${nombre}.log`),
    path.join(cwd, 'server', 'logs', `${nombre}.log`),
    path.join(cwd, 'logs', 'app.log'),
  ]) {
    try {
      if (fs.statSync(candidato).isFile()) return candidato;
    } catch { /* no está, seguimos */ }
  }
  return '';
}

const idValido = (nombre) =>
  nombre.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

async function principal() {
  const procesos = await pm2Jlist();

  if (procesos.length === 0) {
    console.error('PM2 no tiene procesos corriendo.');
    process.exitCode = 1;
    return;
  }

  const lineas = [
    '',
    `# Generado por descubrir-pm2.js el ${new Date().toISOString()}`,
    `# ${procesos.length} aplicación(es) encontrada(s) en PM2.`,
    '# Revisa las rutas y llena a mano los APP_N_DB_URL con usuarios de SOLO LECTURA.',
    '',
  ];

  procesos.forEach((proc, i) => {
    const n = i + 1;
    const entorno = proc.pm2_env ?? {};
    const nombre = proc.name ?? `app-${n}`;

    lineas.push(
      `APP_${n}_ID=${idValido(nombre)}`,
      `APP_${n}_NAME=${nombre}`,
      `APP_${n}_LOG_OUT=${entorno.pm_out_log_path ?? ''}`,
      `APP_${n}_LOG_ERR=${entorno.pm_err_log_path ?? ''}`,
      `APP_${n}_LOG_APP=${logDeLaApp(entorno.pm_cwd, nombre)}`,
      `APP_${n}_LOG_FORMAT=auto`,
      `APP_${n}_DB_URL=`,
      '',
    );
  });

  console.log(lineas.join('\n'));

  // Los avisos van a stderr para que `>> .env` reciba solo configuración.
  const sinHora = procesos.filter((p) => !p.pm2_env?.time);
  if (sinHora.length > 0) {
    console.error(
      `⚠ ${sinHora.length} app(s) no arrancaron con --time: ${sinHora.map((p) => p.name).join(', ')}.\n` +
        '  Si además su logger no estampa su propia hora, no habrá forma de ordenar\n' +
        '  cronológicamente -out.log con -error.log y la fusión perderá precisión.',
    );
  }
}

principal().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
