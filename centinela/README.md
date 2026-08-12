# Centinela

Analista de logs que vive en el mismo servidor que tus aplicaciones. Le das un
`request_id` y te devuelve la petición reconstruida, limpia y lista para
analizar — sin que tengas que entrar por SSH a hacer `grep` a mano.

**Estado: fase 1 terminada.** Recolector, reconstructor y reductor funcionando
por línea de comandos. Todavía no llama a ningún modelo ni tiene interfaz: eso
es la fase 2. Lo que produce hoy es exactamente el texto que se le mandaría a
la IA, para poder medir el ahorro antes de construir nada encima.

## Arrancar

```bash
cd server
cp .env.example .env
npm install
npm run demo
```

`npm run demo` corre sobre el log de ejemplo que viene en `server/logs-demo/`
(un caso real anonimizado) y no necesita servidor, PM2 ni base de datos.

## Qué hace

```
npm run analizar -- --app comunidad --id <request-id> --relacionadas 2
```

1. **Recolecta.** `grep` localiza las líneas con el id; después se lee solo ese
   rango en streaming. Dos pasadas, memoria acotada, y ningún shell de por
   medio.
2. **Funde.** Junta `-out.log`, `-error.log` y el log propio de la app en una
   sola secuencia cronológica. PM2 parte la salida en dos archivos y una
   petición fallida deja media historia en cada uno.
3. **Reconstruye.** Ancla en la línea del id, busca hacia atrás la entrada
   HTTP que casa en método y ruta, y se queda solo con las líneas del mismo
   controlador. Ver abajo por qué esto no es `grep -B10 -A10`.
4. **Limpia.** Redacta datos personales, colapsa repeticiones, iza los campos
   constantes a la cabecera y convierte los timestamps en deltas.
5. **Mide.** Cuenta tokens con `js-tiktoken` y reporta la reducción.

## Por qué no basta con `grep -B 10 -A 10`

En los logs reales el `request_id` se estampa en **una sola línea**, la del
error. Las que cuentan la historia no lo llevan, y como el servidor atiende
varias peticiones a la vez, vienen intercaladas con tráfico de otros usuarios:

```
02:51:49.554  POST | "/usuarios/login"          <- la petición empieza aquí
02:51:49.554  Usuario.login | {...}
02:51:47.112  GET  | "/productos/public"        <- otro usuario, estorba
02:51:49.624  Usuario.validateUser | {...}
02:51:49.624  API.sendApiError | {requestId}    <- la única línea con el id
```

Tomar ±10 líneas a ciegas arrastra el ruido y a veces se pierde el inicio.
Centinela reconstruye por semántica: en el ejemplo que trae el repo, de 38
líneas recolectadas se queda con las 5 que son.

## La redacción no puede destruir la señal

En el caso de ejemplo la causa del fallo es que el correo llega con un espacio
al final. Sustituir a ciegas por `<EMAIL_1>` borraría justo el dato que lo
explica, así que el redactor conserva los espacios marcándolos con `␣` y los
reporta aparte:

```
petición
  +    0ms  POST /usuarios/login (no token)
  +    0ms  Usuario.login  email=<EMAIL_1>␣
  +   70ms  Usuario.validateUser  found=false
  +   70ms  Usuario.login result  ok=false
  +   70ms  API.sendApiError  statusCode=401  errorCode=AUTH_INVALID_CREDENTIALS

peticiones anteriores a la misma ruta (1)
  [1] 2026-08-08T02:51:16.867Z
    +    0ms  POST /usuarios/login (no token)
    +    0ms  Usuario.login  email=<EMAIL_1>
    +   70ms  Usuario.validateUser  found=true  userId=<OID_1>
    +  535ms  Usuario.login result  ok=false
    +  536ms  API.sendApiError  statusCode=401  errorCode=AUTH_INVALID_CREDENTIALS

anomalías en los datos (␣ marca cada espacio)
  · el valor de "email" trae 1 espacio(s) al final
```

Puestas una junto a otra, las dos peticiones cuentan dos fallos distintos y
ninguno es el que dice el mensaje de error.

## Configuración

Todo sale del `.env` (ver `server/.env.example`). Una aplicación es un bloque
`APP_<N>_*`:

```ini
APP_1_ID=comunidad
APP_1_LOG_OUT=/home/deploy/.pm2/logs/comunidad-out.log
APP_1_LOG_ERR=/home/deploy/.pm2/logs/comunidad-error.log
APP_1_LOG_APP=/home/deploy/apps/comunidad/server/logs/comunidad.log
APP_1_LOG_FORMAT=corchetes      # corchetes | json | auto
APP_1_DB_URL=                   # SOLO LECTURA
```

En el servidor no los escribas a mano — PM2 ya sabe las rutas:

```bash
npm run descubrir:pm2 >> .env
```

## Otros comandos

```bash
npm run analizar -- --apps          # lista las apps y valida sus rutas
npm run analizar -- --ayuda
npm test                            # 25 pruebas, sin dependencias externas
```

## Seguridad

Este servicio lee los logs de todas tus aplicaciones y, cuando se conecte,
sus bases de datos. Es el proceso más valioso del servidor para un atacante.

- El patrón de búsqueda se valida contra una lista blanca y los argumentos
  van a `spawn` por arreglo, nunca por string: no hay shell que inyectar.
- Las rutas de log salen siempre del registro del `.env`, jamás de lo que
  escriba el usuario.
- El `.env` va en `.gitignore`. En el servidor, `chmod 600`.
- Los usuarios de base de datos deben tener solo permiso de lectura. En
  Mongo, el rol `read`; en Postgres, `GRANT SELECT` más
  `default_transaction_read_only`.

## Siguiente

- **Fase 2** — capa de IA (OpenAI, con adaptador para cambiar de proveedor) y
  chat en React con soporte de imágenes, protegido con JWT.
- **Fase 3** — consultas parametrizadas de solo lectura a Postgres y Mongo.
- **Fase 4** — historial de incidentes en SQLite.

El diseño completo, con pros, contras y decisiones, está en el documento de
propuesta.
