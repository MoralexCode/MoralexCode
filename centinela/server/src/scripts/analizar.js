#!/usr/bin/env node
/**
 * CLI de la fase 1.
 *
 * Recolecta, reconstruye y limpia una petición, y enseña cuánto se redujo.
 * No llama a ningún modelo: la salida es exactamente el texto que se le
 * mandaría. La idea es medir el ahorro antes de construir nada encima.
 *
 *   npm run analizar -- --app comunidad --id 3cf764de-... --relacionadas 2
 */
import { cargarRegistro, buscarApp } from '../config/apps-registry.js';
import { analizarRequestId } from '../services/analisis.service.js';
import { env } from '../config/env.js';

const AYUDA = `
centinela · analizar

  npm run analizar -- --app <id> --id <request-id> [opciones]

opciones
  --app <id>            aplicación registrada en el .env  (obligatorio)
  --id <request-id>     el identificador a buscar         (obligatorio)
  --relacionadas <n>    incluye las n peticiones anteriores a la misma ruta
  --ventana <ms>        ventana para agrupar líneas de una misma petición
  --sin-redactar        no sustituye datos personales (solo para depurar)
  --crudo               imprime también las líneas sin procesar
  --json                salida en JSON, para encadenar con otra herramienta
  --apps                lista las aplicaciones registradas y termina
  --ayuda               esto

ejemplo
  npm run demo
`;

function parsearArgs(argv) {
  const args = { relacionadas: 0 };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const valor = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`La opción ${a} necesita un valor.`);
      i += 1;
      return v;
    };

    switch (a) {
      case '--app':          args.app = valor(); break;
      case '--id':           args.id = valor(); break;
      case '--relacionadas': args.relacionadas = Number(valor()); break;
      case '--ventana':      args.ventanaMs = Number(valor()); break;
      case '--sin-redactar': args.redactarPii = false; break;
      case '--crudo':        args.crudo = true; break;
      case '--json':         args.json = true; break;
      case '--apps':         args.listar = true; break;
      case '--ayuda':
      case '-h':
      case '--help':         args.ayuda = true; break;
      default:
        throw new Error(`Opción desconocida: ${a}`);
    }
  }
  return args;
}

function barra(fraccion, ancho = 24) {
  const llenos = Math.max(0, Math.min(ancho, Math.round(fraccion * ancho)));
  return '█'.repeat(llenos) + '░'.repeat(ancho - llenos);
}

async function principal() {
  const args = parsearArgs(process.argv.slice(2));

  if (args.ayuda) { console.log(AYUDA); return; }

  // No estricto: si una ruta del .env no existe se avisa pero se sigue con
  // las demás. Al listar apps queremos ver justamente cuál está mal.
  const registro = cargarRegistro({ estricto: false });

  if (args.listar) {
    if (registro.apps.length === 0) {
      console.log('No hay aplicaciones registradas. Copia .env.example a .env y llena un bloque APP_1_*.');
      return;
    }
    for (const app of registro.apps) {
      console.log(`\n${app.id}  —  ${app.nombre}   [formato: ${app.formato}]`);
      for (const f of app.fuentes) {
        console.log(`   ${f.origen.padEnd(6)} ${f.ruta}  (${(f.bytes / 1024).toFixed(1)} KB)`);
      }
      console.log(`   base   ${app.dbUrl ? 'configurada' : '—'}`);
    }
    for (const aviso of registro.avisos) console.warn(`\n⚠ ${aviso}`);
    return;
  }

  if (!args.app || !args.id) {
    console.error('Faltan --app y/o --id.\n' + AYUDA);
    process.exitCode = 1;
    return;
  }

  const app = buscarApp(registro, args.app);
  const inicio = Date.now();
  const resultado = await analizarRequestId(app, args.id, args);
  const ms = Date.now() - inicio;

  if (args.json) {
    console.log(JSON.stringify({ ...resultado, ms }, null, 2));
    return;
  }

  if (!resultado.encontrado) {
    console.error(`\n✗ ${resultado.motivo}`);
    console.error(`  Se revisaron ${resultado.metricas.lineasRecolectadas} líneas en ${resultado.metricas.archivos.join(', ') || 'ninguna fuente'}.`);
    for (const nota of resultado.metricas.notas) console.error(`  ⚠ ${nota}`);
    process.exitCode = 2;
    return;
  }

  if (args.crudo) {
    console.log('\n─── líneas recolectadas, sin procesar ' + '─'.repeat(30));
    console.log(`(${resultado.metricas.lineasRecolectadas} líneas, ${resultado.metricas.formateado.crudo})`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log(resultado.texto);
  console.log('\n' + '═'.repeat(72));

  const m = resultado.metricas;
  const aprox = m.tokensExactos ? '' : ' (estimado)';

  console.log(`
  recolectado   ${String(m.lineasRecolectadas).padStart(4)} líneas   ${m.formateado.crudo.padStart(9)}   ${String(m.tokensCrudos).padStart(6)} tokens${aprox}
  enviado       ${String(m.lineasEnviadas).padStart(4)} líneas   ${m.formateado.final.padStart(9)}   ${String(m.tokensFinales).padStart(6)} tokens${aprox}
  reducción     ${barra(1 - 1 / m.reduccion)}  ${m.reduccion.toFixed(1)}×

  presupuesto   ${m.tokensFinales} / ${env.tokenPresupuesto} tokens  ${m.dentroDelPresupuesto ? '✓' : '✗ SE PASA'}
  redactados    ${m.valoresRedactados} valor(es) sustituido(s)${m.anomalias > 0 ? `,  ${m.anomalias} anomalía(s) detectada(s)` : ''}
  tiempo        ${ms} ms`);

  for (const nota of m.notas) console.warn(`  ⚠ ${nota}`);
  console.log('');
}

principal().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
