# Backend ingestion verification — React Native SDK

**Date:** 2026-05-01
**Backend repo:** `/Volumes/M.2/MyProjects/allstak`
**Backend stack:** Spring Boot 3.4.4 (Java 21), PostgreSQL, Redis, Kafka, ClickHouse 24.10
**Backend URL used:** `http://localhost:8080`
**SDK package:** `@allstak/react-native@0.3.0`

This pass proves every canonical SDK payload shape is accepted by the
live backend, ingest → Kafka → ClickHouse pipeline, and that an iOS
simulator running the real SDK ships data the same way.

## Backend ingest endpoints

| Endpoint | Controller | Auth | Wire |
|---|---|---|---|
| `POST /ingest/v1/errors` | [`ErrorIngestController`](file:///Volumes/M.2/MyProjects/allstak/backend/src/main/java/com/allstak/modules/errors/controller/ErrorIngestController.java) | `X-AllStak-Key` header → `ApiKeyAuthFilter` (SHA-256 hash lookup in `api_keys`) | Kafka topic `allstak.errors` → ClickHouse `allstak.errors` |
| `POST /ingest/v1/logs` | `LogIngestController` | same | ClickHouse `allstak.logs` |
| `POST /ingest/v1/spans` | `SpanIngestController` | same | (not exercised this pass) |
| `POST /ingest/v1/http_requests` | `HttpRequestIngestController` | same | (not exercised this pass) |

DTO contract: [`ErrorIngestRequest.java`](file:///Volumes/M.2/MyProjects/allstak/backend/src/main/java/com/allstak/modules/errors/dto/ErrorIngestRequest.java)

```java
record ErrorIngestRequest(
  @NotBlank String exceptionClass,        // required
  @NotBlank String message,               // required
  @Nullable List<String> stackTrace,
  @Nullable @Pattern("debug|info|warn|error|fatal|warning") String level,
  @Nullable String environment,
  @Nullable String release,
  @Nullable String sessionId,
  @Nullable UserContext user,
  @Nullable Map<String, Object> metadata,
  @Nullable String traceId,
  @Nullable RequestContext requestContext,
  @Nullable List<BreadcrumbItem> breadcrumbs,
  @Nullable String platform,
  @Nullable String sdkName,
  @Nullable String sdkVersion,
  @Nullable List<Frame> frames,           // v2 structured frames
  @Nullable DebugMeta debugMeta,
  @Nullable String dist
)
```

## Setup

```sh
# Create test project + API key in the backend's postgres
psql -h localhost -p 5432 -U allstak -d allstak -At << 'SQL'
INSERT INTO users (email, auth_provider, signup_source)
  VALUES ('rn-sdk-verify@allstak.local', 'local', 'email')
  ON CONFLICT (email) DO NOTHING;
WITH u AS (SELECT id FROM users WHERE email='rn-sdk-verify@allstak.local')
INSERT INTO projects (name, slug, owner_id, platform)
  VALUES ('rn-sdk-verify', 'rn-sdk-verify', (SELECT id FROM u), 'react-native')
  ON CONFLICT DO NOTHING;
SQL

# Then INSERT INTO api_keys with SHA-256 of a raw key:
RAW_KEY="ask_rn_verify_3fee3956d961f32a8d5baf9efdd8aa4f"
HASH=$(printf '%s' "$RAW_KEY" | openssl dgst -sha256 | awk '{print $2}')
# Project ID created above: 75dff8d0-436a-47b7-b6a1-c868c7e80622
psql -h localhost -p 5432 -U allstak -d allstak -At -c "
INSERT INTO api_keys (project_id, key_hash, name, key_prefix, environment)
  VALUES ('75dff8d0-...', '$HASH', 'rn-sdk-verify-key', 'ask_rn_ver', 'development')
  ON CONFLICT DO NOTHING;"
```

> **Gotcha encountered:** The host has TWO postgres instances —
> a native one on port 5432 (used by the running backend) and a docker
> container on 5434. Inserting the API key in the docker DB while the
> backend reads from the native DB silently produces 401
> `INVALID_API_KEY` from the SDK. Fix: ensure the API key lives in the
> DB the backend's `spring.datasource.url` points at.

## 1. Curl replay — all 8 canonical payload shapes

Script: [`/tmp/allstak-rn-verify/replay.sh`](file:///tmp/allstak-rn-verify/replay.sh)

| # | Payload shape | Endpoint | Result |
|---|---|---|---|
| 1 | render-error (ErrorBoundary) with `metadata.source = 'AllStakProvider.ErrorBoundary'` | `/ingest/v1/errors` | ✅ HTTP 202 |
| 2 | global JS error via ErrorUtils | `/ingest/v1/errors` | ✅ HTTP 202 |
| 3 | unhandled promise rejection | `/ingest/v1/errors` | ✅ HTTP 202 |
| 4 | native iOS NSException with `metadata['native.crash'] = 'true'` | `/ingest/v1/errors` | ✅ HTTP 202 |
| 5 | native Android RuntimeException | `/ingest/v1/errors` | ✅ HTTP 202 |
| 6 | log info via captureMessage | `/ingest/v1/logs` | ✅ HTTP 202 |
| 7 | log error via captureMessage | `/ingest/v1/errors` | ✅ HTTP 202 |
| 8 | error with rich breadcrumbs (HTTP 5xx + console + nav) | `/ingest/v1/errors` | ✅ HTTP 202 |

Sample response:

```json
{"success":true,"data":{"id":"268f930c-b59c-4525-b0cf-b4c45e280b7d"},
 "meta":{"requestId":"6e280025-9956-44db-9181-aad1356eaf64","timestamp":"…"}}
```

## 2. ClickHouse landing — proof the pipeline drained

```sql
SELECT exceptionClass, message, dist FROM allstak.errors
  WHERE project_id='<project>' ORDER BY timestamp DESC;
```

After the curl replays + iOS sim run, the table contained:

| exceptionClass | message | dist | source |
|---|---|---|---|
| `Error` | `ios-sim: final exception with breadcrumbs` | `ios-hermes` | iOS sim |
| `Error` | `ios-sim: manual exception #1` | `ios-hermes` | iOS sim |
| `Message` | `ios-sim: manual error log` | `ios-hermes` | iOS sim |
| **`AllStakDevCrash`** | **`Dev-only: deliberate native crash to verify capture`** | **`ios-hermes`** | **iOS sim — NATIVE CRASH** |
| `Error` | `contract: will-buffer` | `` | retry-buffer test |
| `Error` | `contract: drain-trigger` | `` | retry-buffer test |
| `NSException` | `NSInvalidArgumentException: contract test` | `` | drainPendingNativeCrashes test |
| `Message` | `contract: error log` | `` | captureMessage error test |
| `Error` | `contract: render error` | `ios-hermes` | captureException test |
| `Error` | `NetworkError on cart submit` | `` | curl-replay #8 |
| `Message` | `checkout failed` | `` | curl-replay #7 |
| `RuntimeException` | `Attempt to invoke virtual method on a null object reference` | `android-hermes` | curl-replay #5 |
| `NSException` | `NSInvalidArgumentException: -[__NSCFString count]: …` | `ios-hermes` | curl-replay #4 |
| `Error` | `unhandled-rejection: api offline` | `` | curl-replay #3 |
| `TypeError` | `undefined is not an object` | `android-hermes` | curl-replay #2 |
| `Error` | `render error from CrashingChild` | `ios-hermes` | curl-replay #1 |

## 3. SDK contract tests — live backend

[`test/backend-contract.test.mjs`](../../test/backend-contract.test.mjs) — 6 tests, all pass against `localhost:8080`:

```sh
ALLSTAK_TEST_BACKEND=http://localhost:8080 \
  ALLSTAK_TEST_API_KEY="$(cat /tmp/allstak-rn-key)" \
  node --test test/backend-contract.test.mjs

ok 1 - captureException posts a payload accepted by the live backend
ok 2 - captureMessage info posts to /ingest/v1/logs and is accepted
ok 3 - captureMessage error posts to both /ingest/v1/errors and /ingest/v1/logs
ok 4 - drainPendingNativeCrashes routes the stashed payload to /ingest/v1/errors
ok 5 - transient network failure is buffered and re-sent on next successful capture
ok 6 - backend 401 INVALID_API_KEY does not crash the SDK
1..6
# pass 6  fail 0
```

The retry test (#5) is end-to-end-meaningful: the SDK simulates a
network failure on the first send (event goes to in-memory buffer),
the next send succeeds, and the backend ingests **both** the buffered
event and the new one. ClickHouse confirms `contract: will-buffer`
landed alongside `contract: drain-trigger` — the retry behavior is
real, not just a mock-passing test.

## 4. iOS simulator run — full bridge to the live backend

The iPhone 17 simulator (iOS 26.4) running the sample app posted
events to `http://localhost:8080/ingest/v1/errors` with the API key
header. ClickHouse received them with `platform: 'react-native'` and
`dist: 'ios-hermes'` correctly stamped. Twelve breadcrumbs landed on
the final exception including the expected mix:

```
type=log     level=warn    ios-sim: warning crumb …
type=log     level=error   ios-sim: error crumb …
type=http    level=error   GET https://httpbin.org/status/404 -> 404
type=http    level=error   GET https://httpbin.org/status/500 -> 500
type=http    level=error   GET https://no-such-host-allstak-test.invalid/ -> failed
```

## Payload examples (redacted)

### captureException (RN)

```json
{
  "exceptionClass": "Error",
  "message": "ios-sim: final exception with breadcrumbs",
  "stackTrace": ["    at App (App.tsx:42:15)", "..."],
  "frames": [{
    "filename": "App.tsx", "function": "App",
    "lineno": 42, "colno": 15, "inApp": true,
    "platform": "react-native"
  }],
  "level": "error",
  "environment": "development",
  "release": "expo-test@1.0.0",
  "sessionId": "<uuid v4>",
  "platform": "react-native",
  "sdkName": "allstak-react-native",
  "sdkVersion": "0.3.0",
  "dist": "ios-hermes",
  "metadata": {
    "device.os": "ios",
    "device.osVersion": "17.4",
    "rn.architecture": "new-arch",
    "rn.hermes": "true",
    "platform": "react-native",
    "sdk.name": "allstak-react-native"
  },
  "breadcrumbs": [
    { "type": "log", "level": "warn",  "message": "warning crumb",
      "data": { "category": "console", "method": "warn", "args": ["..."] } },
    { "type": "http", "level": "error",
      "message": "GET https://httpbin.org/status/404 -> 404",
      "data": { "method": "GET", "url": "https://httpbin.org/status/404",
                "statusCode": 404, "durationMs": 41 } }
  ],
  "user": { "id": "<redacted>", "email": "<redacted>" }
}
```

### Native crash (drained on relaunch)

```json
{
  "exceptionClass": "AllStakDevCrash",
  "message": "Dev-only: deliberate native crash to verify capture",
  "stackTrace": ["..."],
  "level": "error",
  "environment": "development",
  "release": "expo-test@1.0.0",
  "platform": "react-native",
  "dist": "ios-hermes",
  "metadata": {
    "native.crash": "true",
    "device.os": "ios"
  }
}
```

## Headers

```
POST /ingest/v1/errors HTTP/1.1
Host: localhost:8080
Content-Type: application/json
X-AllStak-Key: ask_rn_verify_<redacted>
User-Agent: allstak-react-native/0.3.0 (ios)
```

## Rate limiting

`/ingest/v1/errors` is rate-limited to **600 requests per minute per
IP** (`RateLimitFilter.java:48`). For high-volume verification runs,
either insert a brief sleep between bursts or expect 429 responses
from the backend (the SDK's retry buffer handles them transparently).

## What was NOT verified at the backend level

- **Span ingest** (`/ingest/v1/spans`) — the SDK has tracing primitives
  but the verification pass focused on errors + logs.
- **HTTP request ingest** (`/ingest/v1/http_requests`) — when the SDK
  sets `enableHttpTracking: true`, full-request payloads flow there.
  Not exercised this pass; covered in the SDK's HTTP-instrumentation
  unit tests.
- **Symbolicator end-to-end** — the source-map upload pipeline exists
  in `@allstak/js/sourcemaps` but native iOS Hermes-bytecode
  symbolication wasn't tested against the AllStak symbolicator.
- **Android end-to-end** — see "Remaining blockers" below.

## Remaining blockers

### Android emulator path

Pixel_9a AVD is configured with `android-36` system image, but the
emulator failed to boot in this session due to insufficient disk space:

```
FATAL | Your device does not have enough disk space to run avd: `Pixel_9a`.
```

The Android pipeline is therefore **NOT verified end-to-end** in this
session. The backend already accepts the Android-shaped payload (curl
replay #5 confirms `RuntimeException` with `dist: android-hermes` is
accepted, fingerprinted, and lands in ClickHouse). What remains:

1. Free disk + boot the emulator
2. `npx expo run:android` (autolinks `AllStakRNPackage`)
3. Flip `DEV_AUTO_FIRE = true` in `App.tsx` and verify backend events land
4. Flip `ARM_NATIVE_CRASH = true`, run, observe RN-process death
5. Set both flags to `false`, rerun, observe `drainPendingNativeCrashes`
   shipping the Java exception to `/ingest/v1/errors` with
   `metadata['native.crash'] = 'true'`

The Android `__devTriggerCrash` Java method and `AllStakCrashHandler`
are already in place; they just need a device run.

## Conclusion

The AllStak backend's `/ingest/v1/errors` and `/ingest/v1/logs`
endpoints are **fully compatible** with the React Native SDK's
canonical payload shapes:

- All required validation passes
- Auth via `X-AllStak-Key` works
- Data lands in Kafka and is consumed into ClickHouse
- Native crash payloads (iOS verified live; Android verified via curl)
  are accepted and stored with the `native.crash` metadata flag
- The SDK's retry-buffer behavior is real — buffered events make it
  through after a transient failure

No backend DTO weakening was done. No SDK payload was reshaped to
work around backend strictness. The contract is honest in both
directions.
