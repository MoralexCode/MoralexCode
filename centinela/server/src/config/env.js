import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const aqui = path.dirname(fileURLToPath(import.meta.url));

/** Raíz de server/ — todas las rutas relativas del .env se resuelven contra aquí. */
export const RAIZ = path.resolve(aqui, '..', '..');

dotenv.config({ path: path.join(RAIZ, '.env'), quiet: true });

const num = (clave, porDefecto) => {
  const crudo = process.env[clave];
  if (crudo === undefined || crudo === '') return porDefecto;
  const n = Number(crudo);
  if (!Number.isFinite(n)) {
    throw new Error(`La variable ${clave} debe ser un número, llegó "${crudo}"`);
  }
  return n;
};

const bool = (clave, porDefecto) => {
  const crudo = process.env[clave];
  if (crudo === undefined || crudo === '') return porDefecto;
  return /^(1|true|si|sí|yes)$/i.test(crudo.trim());
};

export const env = {
  puerto: num('PORT', 4300),
  host: process.env.HOST || '127.0.0.1',
  entorno: process.env.NODE_ENV || 'development',

  contextoAntes: num('LOG_CONTEXTO_ANTES', 40),
  contextoDespues: num('LOG_CONTEXTO_DESPUES', 15),
  ventanaMs: num('LOG_VENTANA_MS', 5000),

  maxCoincidencias: num('LOG_MAX_COINCIDENCIAS', 200),
  maxBytes: num('LOG_MAX_BYTES', 5 * 1024 * 1024),
  timeoutMs: num('LOG_TIMEOUT_MS', 10_000),

  tokenPresupuesto: num('TOKEN_PRESUPUESTO', 25_000),
  redactarPii: bool('REDACTAR_PII', true),
};
