# Auth0 M2M STAGING: datos de incorporación

Estado al 20 de julio de 2026: la certificación, la aprobación y la activación auditable de STAGING están completas. La activación inmutable fue registrada a las 04:15:33 ET por sebastian; el cliente, la credencial y los dos grants están en `ACTIVE`. Las UIs de aprobación y activación están cerradas, el verificador Auth0 está desplegado con `ORDERPRO_M2M_AUTH_MODE="AUTH0"` y Local Delivery V4 permanece cerrado con su gate en `false`.

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

Durante el onboarding, la certificación y la aprobación, la configuración
server-only se mantuvo cerrada con este formato. Los valores reales no se copian
a esta guía; el despliegue actual cambió el modo a `AUTH0` únicamente después de
cerrar las UIs y completar la activación:

```env
ORDERPRO_M2M_AUTH_MODE="DISABLED"
ORDERPRO_M2M_ISSUER="https://<AUTH0_STAGING_DOMAIN>/"
ORDERPRO_M2M_AUDIENCE="<AUTH0_API_AUDIENCE>"
ORDERPRO_M2M_JWKS_URI="https://<AUTH0_STAGING_DOMAIN>/.well-known/jwks.json"
ORDERPRO_M2M_ALLOWED_ALGORITHM="RS256"
```

## Estado del onboarding

El dominio, audience y Client ID públicos del piloto fueron recibidos. El Client ID se registró mediante `npm run m2m:onboard:staging` como credencial externa de la identidad interna `storefront-staging`, nunca dentro de una allowlist de `.env` ni de una migración versionada. Después de certificar el token y registrar por separado la aprobación y la activación auditadas, el cliente, la credencial y sus dos grants están en `ACTIVE`.

El comando acepta únicamente `--issuer` y `--client-id`. No existe una opción para Client Secret:

```powershell
npm run m2m:onboard:staging -- --issuer="https://<tenant>.us.auth0.com/" --client-id="<client-id-publico>"
```

Los grants activos son exactamente `local-delivery:quote` y `local-delivery:holds`. La activación quedó atribuida al Owner autenticado que tomó la decisión; no se inventó un propietario para la identidad técnica.

El Client ID no se guardó como secreto ni como allowlist de entorno: quedó asociado al registro durable `storefront-staging`. El despliegue actual usa `ORDERPRO_M2M_AUTH_MODE="AUTH0"`; ambos gates de administración M2M están en `false` y `ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED` permanece en `false`.

La validación de configuración está en `src/infrastructure/m2m/auth0-config.ts`. Rechaza de forma cerrada valores incompletos, dominios no canónicos, cualquier audience distinto de `https://api.orderpro.internal/local-delivery/staging`, endpoints JWKS distintos al issuer, algoritmos diferentes a RS256 y cualquier entorno que no sea STAGING.

El autenticador RFC 9068 está implementado en `src/infrastructure/m2m/auth0-machine-authenticator.ts` y desplegado en STAGING. Verifica la firma contra el JWKS fijo del tenant, selecciona llaves por `kid`, exige issuer/audience/`client_id`/subject/expiración/scopes exactos y después consulta el registro durable. Una firma válida por sí sola no autoriza: cliente, credencial y grant también deben estar activos. Una llamada a `auth-check` sin token ya confirmó el límite fail-closed con `401 UNAUTHORIZED`; todavía debe conservarse evidencia de una llamada posterior con un token efímero válido que devuelva `AUTHENTICATED`.

La certificación de extremo a extremo produjo evidencia sanitizada `CERTIFIED_PENDING_APPROVAL`, que posteriormente fue consumida por la aprobación y la activación inmutables. El token y el Client Secret no deben copiarse a documentación, commits, capturas ni mensajes.

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

## Aprobación humana previa a la activación

En esta etapa histórica, `CERTIFIED_PENDING_APPROVAL` habilita una decisión humana auditable, no el
tráfico. La aprobación se registra únicamente después de desplegar la migración
que crea `record_staging_machine_authorization_approval`. Esa función mantiene el
cliente, la credencial y los dos grants en `PENDING_VERIFICATION`; los tres
triggers contra `ACTIVE`, `ORDERPRO_M2M_AUTH_MODE=DISABLED` y
`ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED=false` permanecen intactos.

### Ruta recomendada: sesión humana autenticada

OrderPRO expone `/operations/admin/m2m` dentro del panel operativo. La página y
su Server Action vuelven a validar la sesión Supabase y exigen el permiso
`m2m.approve`, que pertenece únicamente al rol `OWNER`. El actor se deriva de la
sesión y de `User.subject`; el navegador nunca envía un UUID de usuario, cliente,
scope, estado, commit ni árbol como autoridad.

El formulario permanece bloqueado de forma predeterminada. El despliegue
STAGING debe aportar estas atestaciones server-only desde CI:

```dotenv
ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED="false"
ORDERPRO_RELEASE_COMMIT_SHA="<commit desplegado>"
ORDERPRO_RELEASE_TREE_SHA="<árbol del commit desplegado>"
ORDERPRO_RELEASE_M2M_CERTIFIED_COMMIT_SHA="<commit de la certificación>"
ORDERPRO_RELEASE_M2M_CERTIFIED_TREE_SHA="<árbol de la certificación>"
ORDERPRO_RELEASE_M2M_CERTIFICATION_ANCESTOR_CONFIRMED="true"
ORDERPRO_RELEASE_M2M_VERIFIER_DIGEST_SHA256="<digest certificado>"
```

Antes de establecer temporalmente el gate UI en `true`, CI debe comprobar que
el commit certificado es ancestro del release, que ambos árboles corresponden a
sus commits y que el digest del verificador coincide con la evidencia
`m2m.client.token_certified`. La acción solo funciona con `NODE_ENV=production`,
`ORDERPRO_RUNTIME_ENVIRONMENT=STAGING`, M2M en `DISABLED`, la API V4 en `false`,
configuración Auth0 canónica, cero secretos/tokens heredados, RLS, función
`SECURITY DEFINER` ejecutable, guards append-only y los tres triggers de no
activación intactos. En `next dev`/localhost se puede revisar la pantalla,
pero no registrar la decisión.

El Owner revisa el snapshot y la evidencia, escribe una razón de 10–500
caracteres sin secretos y confirma exactamente
`APPROVE STOREFRONT-STAGING WITHOUT ACTIVATION`. La acción relee todo dentro de
una transacción serializable y llama a la función SQL auditada. El resultado
válido es exclusivamente `APPROVED_PENDING_ACTIVATION`. Después de registrar la
decisión, vuelve a dejar el gate UI en `false`; esto tampoco activa el cliente.

La ruta web autenticada reemplaza el UUID manual como procedimiento normal. El
wrapper CLI siguiente queda como herramienta operativa de contingencia y sigue
requiriendo un change record que vincule al Owner con el operador privilegiado.

El aprobador debe ser un usuario activo con rol `OWNER`. Desde un commit revisado
y con el árbol Git completamente limpio, ejecuta el wrapper directamente; no se
agrega un alias a `package.json` porque ese archivo forma parte del digest que ya
fue certificado:

> **Límite de confianza:** este wrapper comprueba que `ActorUserId` pertenece a
> un `OWNER` activo, pero una conexión privilegiada a PostgreSQL no demuestra por
> sí sola que esa persona inició sesión o ejecutó el comando. Desplegar la
> migración no crea ninguna decisión. No ejecutes el wrapper hasta que exista un
> change record aprobado por ese Owner y un control operativo que vincule al
> operador privilegiado con esa decisión, o hasta sustituirlo por una ruta con
> sesión humana Supabase autenticada. El `actorId` del audit es una atribución
> operativa; no es una firma de no repudio.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/approve-auth0-m2m-staging.ps1 `
  -ActorUserId "<owner-user-uuid>" `
  -Reason "Approved for the separate STAGING activation review." `
  -CertificationAuditEventId "<auditEventId de CERTIFIED_PENDING_APPROVAL>" `
  -EvidenceDigestSha256 "<evidenceDigestSha256 de CERTIFIED_PENDING_APPROVAL>"
```

Desde **CMD**, usa la misma orden en una sola línea (sin los acentos graves de
continuación de PowerShell):

```bat
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\approve-auth0-m2m-staging.ps1 -ActorUserId "<owner-user-uuid>" -Reason "Approved for the separate STAGING activation review." -CertificationAuditEventId "<auditEventId>" -EvidenceDigestSha256 "<evidenceDigestSha256>"
```

Estos cuatro valores son metadatos no secretos. La razón debe tener entre 10 y
500 caracteres y no debe contener tokens, secretos ni encabezados Authorization.
El comando no acepta argumentos adicionales, Client Secret, access token,
Management API token, Client ID ni cambios de flags. El wrapper lee solamente la
configuración server-side requerida, crea un entorno hijo allowlisted y fija el
commit y árbol esperados. El hijo vuelve a comprobar Git, el digest del verificador,
el audit de certificación, el OWNER activo y el snapshot pendiente exacto dentro
de una transacción serializable; repite Git y digest antes de confirmar.

Una respuesta correcta es deliberadamente explícita sobre los bloqueos:

```json
{
  "result": "APPROVED_PENDING_ACTIVATION",
  "clientKey": "storefront-staging",
  "environment": "STAGING",
  "clientStatus": "PENDING_VERIFICATION",
  "credentialStatus": "PENDING_VERIFICATION",
  "grantStatus": "PENDING_VERIFICATION",
  "m2mAuthMode": "DISABLED",
  "localDeliveryV4ApiEnabled": false,
  "activationBlockerCount": 3
}
```

Conserva los IDs y digests sanitizados en el change record. No ejecutes SQL
manual para convertir filas a `ACTIVE`: la activación será otro artefacto
forward-only, con revisión, pruebas y aprobación separadas. La aprobación aquí
descrita no abre ninguna ruta y no autoriza todavía al storefront. Un reintento
después de una aprobación ya registrada falla cerrado para impedir una segunda
decisión; antes de repetir, consulta el change record por el audit ID original.

## Activación separada y prueba de conexión

Esta etapa se completó el 20 de julio de 2026. La activación inmutable quedó
registrada a las 04:15:33 ET por sebastian, y el cliente, la credencial y los dos
grants quedaron en `ACTIVE`. Después se cerró la UI de activación y se desplegó
Auth0 en el runtime en un cambio separado; la UI de aprobación también permanece
cerrada y Local Delivery V4 continúa deshabilitado.

La activación preparada consume la aprobación inmutable mediante una segunda
ventana autenticada de Owner. La migración instala un RPC auditado, pero no
activa filas por sí sola. Durante esa ventana deben permanecer:

```env
ORDERPRO_M2M_AUTH_MODE="DISABLED"
ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED="false"
ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED="false"
ORDERPRO_M2M_STAGING_ACTIVATION_UI_ENABLED="true"
```

La confirmación exacta es:

```text
ACTIVATE STOREFRONT-STAGING M2M ONLY
```

Una activación correcta cambia atómicamente a `ACTIVE` el cliente, su única
credencial certificada y los dos grants aprobados. También crea un
`AuditEvent` y un registro append-only `MachineAuthorizationActivation`. No
habilita Auth0 en el runtime ni abre quote/holds.

Después se cierra inmediatamente la ventana de activación y, en un despliegue
separado, se configura `ORDERPRO_M2M_AUTH_MODE="AUTH0"`. El backend del
storefront puede probar su token con:

```text
POST /api/v1/local-delivery/auth-check
Authorization: Bearer <token efímero>
X-Correlation-ID: <id seguro>
```

Una respuesta `AUTHENTICATED` demuestra issuer, audience, firma, vigencia,
cliente durable y ambos scopes. La misma respuesta declara
`localDeliveryApiStatus: DEPENDENCY_BLOCKED`: no autoriza a presentar precios,
slots ni crear reservas hasta certificar y publicar todas las dependencias V4.

La verificación operativa posterior confirmó `401 UNAUTHORIZED` sin token,
`503 M2M_AUTH_NOT_CONFIGURED` en quote y holds, `200` en `/api/health` con
`productionOperationsEnabled: false`, y `200`/`ready: true` en
`/api/health/ready` con PostgreSQL y autenticación disponibles. El `401` prueba
el rechazo seguro de una solicitud anónima; no sustituye la prueba pendiente con
un token efímero válido en `auth-check`.
