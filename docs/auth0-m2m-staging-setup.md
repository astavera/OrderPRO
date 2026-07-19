# Auth0 M2M STAGING: datos de incorporación

Estado: verificador y registro implementados en preparación segura. Esta configuración no activa Local Delivery V4 ni crea una ruta pública para recibir credenciales.

## Qué dato necesitamos realmente

Auth0 no entrega un `tenant ID` separado que OrderPro necesite para validar llamadas. El dato útil es el **Tenant Domain** canónico, por ejemplo:

```text
orderpro-staging.us.auth0.com
```

Con ese dominio, OrderPro deriva dos valores públicos:

```text
Issuer: https://orderpro-staging.us.auth0.com/
JWKS:   https://orderpro-staging.us.auth0.com/.well-known/jwks.json
```

También necesitamos el **API Identifier/Audience** y el **Client ID** público de la aplicación Machine to Machine. Ninguno de esos tres datos es una contraseña.

## Ruta en el panel de Auth0

1. Abre el [Auth0 Dashboard](https://manage.auth0.com/) y selecciona o crea el tenant destinado únicamente a **STAGING**.
2. En **Settings > General**, copia el campo **Domain**. No copies ningún secreto.
3. Ve a **Applications > APIs > Create API**.
4. Usa el nombre `OrderPro Local Delivery STAGING`.
5. Usa como **Identifier** `https://api.orderpro.internal/local-delivery/staging`. Ese valor será el audience y no debe reutilizarse en producción. No uses el dominio del tenant porque Auth0 lo reserva.
6. Mantén la firma en **RS256**, selecciona el perfil de access token **RFC 9068** y una vigencia de **3600 segundos**.
7. En los permisos de esa API crea exactamente:
   - `local-delivery:quote`
   - `local-delivery:holds`
8. Ve a **Applications > Applications > Create Application**, usa el nombre `OrderPro Storefront STAGING` y selecciona **Machine to Machine**.
9. Autoriza únicamente la API de OrderPro y los dos permisos anteriores. Copia el **Client ID**, pero no el **Client Secret**.

Las referencias oficiales de Auth0 son: [crear tenants](https://auth0.com/docs/get-started/auth0-overview/create-tenants), [registrar APIs](https://auth0.com/docs/get-started/auth0-overview/set-up-apis), [crear aplicaciones M2M](https://auth0.com/docs/get-started/auth0-overview/create-applications/machine-to-machine-apps) y [perfiles de access token](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles).

## Plantilla segura para enviarnos

Copia solamente estos datos y reemplaza los ejemplos:

```text
AUTH0_STAGING_DOMAIN=orderpro-staging.us.auth0.com
AUTH0_API_AUDIENCE=https://api.orderpro.internal/local-delivery/staging
AUTH0_M2M_CLIENT_ID=<client-id-publico>
AUTH0_SCOPES=local-delivery:quote local-delivery:holds
```

**No envíes el Client Secret**, un access token, un Management API token, una llave privada ni una captura donde aparezca alguno de ellos.

El Client Secret pertenece exclusivamente al servidor consumidor —por ejemplo, el storefront— y debe guardarse en su gestor de secretos. OrderPro es el servidor que recibe y valida el token; no necesita ese secreto.

## Dónde quedará en OrderPro

La plantilla server-only ya está preparada en `.env.local`. Cuando recibamos y validemos el Domain y el Audience, se completarán así:

```env
ORDERPRO_M2M_AUTH_MODE="DISABLED"
ORDERPRO_M2M_ISSUER="https://<AUTH0_STAGING_DOMAIN>/"
ORDERPRO_M2M_AUDIENCE="<AUTH0_API_AUDIENCE>"
ORDERPRO_M2M_JWKS_URI="https://<AUTH0_STAGING_DOMAIN>/.well-known/jwks.json"
ORDERPRO_M2M_ALLOWED_ALGORITHM="RS256"
```

## Estado del onboarding

El dominio, audience y Client ID públicos del piloto ya fueron recibidos. El Client ID se registra mediante `npm run m2m:onboard:staging` como credencial externa de la identidad interna `storefront-staging`, nunca dentro de una allowlist de `.env` ni de una migración versionada. El cliente, la credencial y sus grants nacen en `PENDING_VERIFICATION`; un bloqueo de base de datos impide convertirlos a `ACTIVE` hasta una futura aprobación auditada.

El comando acepta únicamente `--issuer` y `--client-id`. No existe una opción para Client Secret:

```powershell
npm run m2m:onboard:staging -- --issuer="https://<tenant>.us.auth0.com/" --client-id="<client-id-publico>"
```

Los grants previstos son exactamente `local-delivery:quote` y `local-delivery:holds`. El propietario queda pendiente en vez de inventar una persona, y el runtime continúa bloqueado aunque el registro se haya creado correctamente.

El modo permanece `DISABLED` durante esta preparación. El Client ID no se guardará como secreto ni como variable temporal: se incorporará al registro durable de clientes M2M con una identidad interna estable, propietario, entorno, estado y permisos auditables.

La validación de configuración está en `src/infrastructure/m2m/auth0-config.ts`. Rechaza de forma cerrada valores incompletos, dominios no canónicos, cualquier audience distinto de `https://api.orderpro.internal/local-delivery/staging`, endpoints JWKS distintos al issuer, algoritmos diferentes a RS256 y cualquier entorno que no sea STAGING.

El autenticador RFC 9068 ya está implementado en `src/infrastructure/m2m/auth0-machine-authenticator.ts`. Verifica la firma contra el JWKS fijo del tenant, selecciona llaves por `kid`, exige issuer/audience/`client_id`/subject/expiración/scopes exactos y después consulta el registro durable. Una firma válida por sí sola no autoriza: cliente, credencial y grant también deben estar activos. En este momento continúan pendientes, el modo sigue `DISABLED` y el runtime permanece cerrado.

Antes de activarlo falta obtener un token de prueba desde el servidor consumidor, ejecutar la certificación de extremo a extremo y aprobar de forma auditada el cliente y sus grants. Ese token y el Client Secret no deben copiarse a documentación, commits, capturas ni mensajes; la prueba se ejecutará desde el entorno seguro que ya posea el secreto.

## Certificación real sin activar el API

Antes de generar el token, confirma en Auth0:

1. **Applications > APIs > OrderPro Local Delivery STAGING > Settings**:
   - **Maximum Access Token Lifetime (Seconds):** `3600`
   - **JSON Web Token (JWT) Profile:** `RFC 9068`
   - **JSON Web Token (JWT) Signing Algorithm:** `RS256`
2. En **Permissions** o **Scopes** deben existir exactamente:
   - `local-delivery:quote`
   - `local-delivery:holds`
3. En **Application Access** o **Machine-to-Machine Applications**, `OrderPro Storefront STAGING` debe tener acceso únicamente a esos dos permisos.

Después abre la pestaña **Test** de la API, selecciona `OrderPro Storefront STAGING` y genera un access token. No copies el ejemplo cURL porque puede contener el Client Secret. No pegues el token en un chat, archivo, `.env.local`, ticket, captura o sitio externo como jwt.io. Si usas el portapapeles de Windows, elimina también esa entrada de **Win+V** al terminar; vaciar el portapapeles actual no borra automáticamente su historial o sincronización en la nube.

El certificador exige primero un commit revisado y un árbol Git completamente limpio, incluyendo archivos nuevos. El wrapper fija los hashes de commit y árbol antes del prompt, vuelve a comprobarlos después de pegar el token y el proceso hijo rechaza cualquier hash diferente. Esto evita certificar código distinto al que quedó registrado. Si todavía existen cambios locales, no generes el token: revisa y crea el commit antes de continuar.

En una terminal nueva, desde la raíz de OrderPro, ejecuta:

```powershell
npm run m2m:certify:staging
```

La terminal pedirá `Paste the Auth0 access token (input is hidden)`. Pega únicamente el access token y presiona Enter. La entrada no se muestra; el wrapper la entrega por una tubería `stdin` con tiempo máximo, borra sus buffers mutables e intenta limpiar el portapapeles actual al terminar mediante la API compatible con Windows PowerShell 5.1. Esa limpieza es de mejor esfuerzo y no borra el historial de **Win+V** ni la sincronización en la nube. El token nunca viaja en argumentos, archivos ni variables de entorno. El wrapper también rechaza secretos o tokens Auth0 heredados por la terminal. El proceso hijo recibe una lista mínima de variables: conexión a la base, configuración pública del verificador, bloqueos del runtime, hashes esperados y la ruta de Git.

El comando usa `-ExecutionPolicy Bypass` únicamente para ese proceso de PowerShell porque la política local bloquea scripts sin firma. No cambia la política del equipo; antes de leer el token, el propio wrapper confirma que su archivo pertenece al commit limpio que se va a certificar.

Una certificación correcta devuelve solamente evidencia no sensible similar a:

```json
{
  "result": "CERTIFIED_PENDING_APPROVAL",
  "clientKey": "storefront-staging",
  "environment": "STAGING",
  "status": "PENDING_VERIFICATION",
  "audience": "https://api.orderpro.internal/local-delivery/staging",
  "scopes": ["local-delivery:holds", "local-delivery:quote"],
  "sourceCommitSha": "<git-commit>",
  "correlationId": "<uuid>",
  "auditEventId": "<uuid>",
  "evidenceDigestSha256": "<sha256>"
}
```

El certificador usa el mismo verificador productivo y el JWKS real. También demuestra que el registro productivo continúa rechazando al cliente pendiente. La evidencia incluye commit, árbol Git y digest del verificador, comprobados antes y después de validar el token. Si todo coincide, actualiza únicamente `MachineCredential.verifiedAt`, incrementa su versión y crea `m2m.client.token_certified`; el cliente, la credencial, ambos grants, `ORDERPRO_M2M_AUTH_MODE` y el runtime siguen cerrados.

Los errores son deliberadamente sanitizados. `UNSAFE_CERTIFICATION_ENVIRONMENT` indica configuración insegura, código sin commit o un árbol Git sucio. `TOKEN_VERIFICATION_FAILED` indica que firma, issuer, audience, perfil, duración, Client ID o scopes no coinciden. `PENDING_REGISTRATION_NOT_READY` indica que el registro ya cambió o no tiene exactamente el estado esperado. Ningún fallo guarda evidencia ni activa permisos.
