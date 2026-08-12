import test from 'node:test';
import assert from 'node:assert/strict';
import { parsearLinea, detectarFormato } from '../src/services/log-parser.service.js';

const opciones = { formato: 'corchetes', archivo: 'x.log', numero: 1 };

test('lee una línea de entrada HTTP', () => {
  const r = parsearLinea(
    '[2026-08-08T02:51:49.554Z] [200]  info: POST | NO TOKEN  | "/usuarios/login"',
    opciones,
  );
  assert.equal(r.reconocida, true);
  assert.equal(r.nivel, 'info');
  assert.deepEqual(r.http, { metodo: 'POST', auth: 'NO TOKEN', ruta: '/usuarios/login' });
  assert.equal(r.ts, Date.parse('2026-08-08T02:51:49.554Z'));
});

test('lee una línea con etiqueta y payload JSON', () => {
  const r = parsearLinea(
    '[2026-08-08T02:51:49.624Z] [200]  info: Usuario.validateUser | {"found":false,"controlador":"UsuariosController"}',
    opciones,
  );
  assert.equal(r.etiqueta, 'Usuario.validateUser');
  assert.equal(r.payload.found, false);
  assert.equal(r.controlador, 'UsuariosController');
  assert.equal(r.http, null);
});

test('extrae el request id del payload', () => {
  const r = parsearLinea(
    '[2026-08-08T02:51:49.624Z] [200]  info: API.sendApiError | {"requestId":"3cf764de-e7bc-4fd7-b3cf-e5533165f7fd","statusCode":401}',
    opciones,
  );
  assert.equal(r.requestId, '3cf764de-e7bc-4fd7-b3cf-e5533165f7fd');
  assert.equal(r.payload.statusCode, 401);
});

test('el corchete de status no se confunde con el status real', () => {
  // La línea dice [200] pero el error fue 401: el dato bueno está dentro
  // del JSON. Si algún día se filtrara por el corchete, este caso avisa.
  const r = parsearLinea(
    '[2026-08-08T02:51:49.624Z] [200]  info: API.sendApiError | {"statusCode":401}',
    opciones,
  );
  assert.equal(r.marca, '200');
  assert.equal(r.payload.statusCode, 401);
  assert.notEqual(String(r.payload.statusCode), r.marca);
});

test('aguanta JSON anidado con llaves dentro de cadenas', () => {
  const r = parsearLinea(
    '[2026-08-08T02:51:49.624Z] [200]  info: X | {"a":{"b":1},"c":"llave } de mentiras"}',
    opciones,
  );
  assert.equal(r.payload.a.b, 1);
  assert.equal(r.payload.c, 'llave } de mentiras');
});

test('una línea que no encaja se conserva cruda', () => {
  const r = parsearLinea('    at Client._handler (pg/lib/client.js:118:28)', opciones);
  assert.equal(r.reconocida, false);
  assert.equal(r.continuacion, true);
  assert.match(r.crudo, /pg\/lib\/client\.js/);
});

test('lee el formato JSON de pino', () => {
  const r = parsearLinea(
    '{"level":30,"time":1754621509624,"msg":"login fallido","reqId":"abc-123","controlador":"Usuarios"}',
    { ...opciones, formato: 'json' },
  );
  assert.equal(r.nivel, 'info');
  assert.equal(r.etiqueta, 'login fallido');
  assert.equal(r.requestId, 'abc-123');
  assert.equal(r.ts, 1754621509624);
});

test('detecta el formato solo', () => {
  assert.equal(detectarFormato(['[2026-01-01T00:00:00Z] [200]  info: hola']), 'corchetes');
  assert.equal(detectarFormato(['{"level":30,"msg":"hola"}']), 'json');
});
