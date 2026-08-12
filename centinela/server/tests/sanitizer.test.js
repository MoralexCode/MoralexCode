import test from 'node:test';
import assert from 'node:assert/strict';
import { crearRedactor } from '../src/services/log-sanitizer.service.js';
import { validarPatron } from '../src/services/log-collector.service.js';

test('el mismo valor recibe siempre el mismo marcador', () => {
  const r = crearRedactor();
  const a = r.redactarTexto('escribió ana@correo.com y luego ana@correo.com');
  assert.equal(a, 'escribió <EMAIL_1> y luego <EMAIL_1>');
});

test('valores distintos reciben marcadores distintos', () => {
  const r = crearRedactor();
  const a = r.redactarTexto('ana@correo.com contra beto@correo.com');
  assert.equal(a, '<EMAIL_1> contra <EMAIL_2>');
});

test('preserva los espacios sobrantes en lugar de borrarlos', () => {
  // Este es el caso que motivó el diseño: el espacio al final del correo
  // ES la causa del error. Si la redacción se lo come, el análisis pierde
  // la única pista que había.
  const r = crearRedactor();

  const conEspacio = r.redactarValor('mariana.reyes@correo.com ', 'email');
  const sinEspacio = r.redactarValor('mariana.reyes@correo.com', 'email');

  assert.equal(conEspacio, '<EMAIL_1>␣');
  assert.equal(sinEspacio, '<EMAIL_1>');
  assert.notEqual(conEspacio, sinEspacio);

  const anomalia = r.anomalias.find((a) => a.tipo === 'espacios');
  assert.ok(anomalia, 'debió reportar la anomalía');
  assert.match(anomalia.detalle, /1 espacio\(s\) al final/);
});

test('oculta el valor de las claves sensibles', () => {
  const r = crearRedactor();
  const salida = r.redactarPayload({ email: 'ana@correo.com', password: 'hunter2', token: 'abc' });
  assert.equal(salida.password, '<SECRETO>');
  assert.equal(salida.token, '<SECRETO>');
  assert.equal(salida.email, '<EMAIL_1>');
});

test('redacta JWT, IP y ObjectId', () => {
  const r = crearRedactor();
  const texto = r.redactarTexto(
    'ip=189.203.44.17 user=6b1204ccae874617fd2282ff jwt=eyJhbGciOi.eyJzdWIiOjE.SflKxwRJSM',
  );
  assert.match(texto, /<IP_1>/);
  assert.match(texto, /<OID_1>/);
  assert.match(texto, /<JWT_1>/);
});

test('no confunde una fecha con una tarjeta', () => {
  const r = crearRedactor();
  const texto = r.redactarTexto('creado 2026080802511649 fin');
  assert.match(texto, /2026080802511649/, 'no debía redactar: no pasa Luhn');
});

test('redacta un número de tarjeta que sí pasa Luhn', () => {
  const r = crearRedactor();
  assert.match(r.redactarTexto('tarjeta 4539578763621486 ok'), /<TARJETA_1>/);
});

test('respeta los valores marcados como intactos', () => {
  const id = 'ana@correo.com';
  const r = crearRedactor({ preservar: [id] });
  assert.equal(r.redactarTexto(`ref ${id}`), `ref ${id}`);
});

test('desactivado, no toca nada', () => {
  const r = crearRedactor({ activo: false });
  assert.equal(r.redactarTexto('ana@correo.com'), 'ana@correo.com');
});

test('rechaza patrones de búsqueda con metacaracteres de shell', () => {
  // La defensa real es pasar los argumentos por arreglo a spawn, sin
  // shell. Esta validación es la segunda capa.
  for (const malo of ['; rm -rf /', '$(whoami)', '`id`', 'a b', '../../etc/passwd\n', 'ab']) {
    assert.throws(() => validarPatron(malo), /inválido/, `debió rechazar: ${malo}`);
  }
});

test('acepta un request id normal', () => {
  assert.doesNotThrow(() => validarPatron('3cf764de-e7bc-4fd7-b3cf-e5533165f7fd'));
});
