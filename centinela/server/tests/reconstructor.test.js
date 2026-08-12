import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsearLinea } from '../src/services/log-parser.service.js';
import { reconstruir, rutasCompatibles } from '../src/services/request-reconstructor.service.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(aqui, '..', 'logs-demo', 'comunidad-out.log');
const ID = '3cf764de-e7bc-4fd7-b3cf-e5533165f7fd';

const registros = fs
  .readFileSync(DEMO, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((texto, i) => parsearLinea(texto, { formato: 'corchetes', archivo: DEMO, numero: i + 1 }));

test('la ruta montada casa con la ruta completa del error', () => {
  assert.equal(rutasCompatibles('/api/v1/usuarios/login', '/usuarios/login'), true);
  assert.equal(rutasCompatibles('/api/v1/usuarios/login', '/usuarios/registro'), false);
});

test('los segmentos con :param casan con cualquier valor', () => {
  assert.equal(rutasCompatibles('/api/v1/productos/sku/ABC-99', '/productos/sku/:sku'), true);
});

test('reconstruye la petición sin arrastrar tráfico ajeno', () => {
  const r = reconstruir(registros, ID, { ventanaMs: 5000 });

  assert.equal(r.encontrado, true);
  assert.equal(r.completa, true);
  assert.equal(r.peticion.controlador, 'UsuariosController');
  assert.equal(r.peticion.estado, 401);
  assert.equal(r.peticion.lineas.length, 5);

  // Ni una sola línea de las peticiones concurrentes a /productos.
  const rutas = r.peticion.lineas.map((l) => l.http?.ruta).filter(Boolean);
  assert.deepEqual(rutas, ['/usuarios/login']);
  assert.equal(
    r.peticion.lineas.some((l) => l.controlador === 'Productos'),
    false,
  );

  // Empieza en la entrada HTTP y termina en la línea del id.
  assert.equal(r.peticion.lineas[0].http.metodo, 'POST');
  assert.equal(r.peticion.lineas.at(-1).requestId, ID);
});

test('trae la petición anterior a la misma ruta', () => {
  const r = reconstruir(registros, ID, { ventanaMs: 5000, relacionadas: 2 });

  assert.equal(r.relacionadas.length, 1);
  const previa = r.relacionadas[0];
  assert.equal(previa.controlador, 'UsuariosController');

  // Es la que sí encontró al usuario: el contraste entre found:true y
  // found:false es justo lo que explica el fallo.
  const validate = previa.lineas.find((l) => l.etiqueta === 'Usuario.validateUser');
  assert.equal(validate.payload.found, true);
});

test('avisa cuando el id no aparece', () => {
  const r = reconstruir(registros, '00000000-0000-0000-0000-000000000000', {});
  assert.equal(r.encontrado, false);
  assert.match(r.motivo, /no aparece/);
});

test('sin línea de entrada cae a la ventana temporal y lo marca', () => {
  // Se quitan las entradas HTTP para forzar el camino de respaldo.
  const sinEntradas = registros.filter((r) => !r.http);
  const r = reconstruir(sinEntradas, ID, { ventanaMs: 5000 });

  assert.equal(r.encontrado, true);
  assert.equal(r.completa, false);
  assert.match(r.motivo, /entrada HTTP/);
});
