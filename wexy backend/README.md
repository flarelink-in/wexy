# Wexy backend

Java 21 services for the browser studio. `forge-common` holds shared contracts;
`forge-gateway` provides authentication, App Check, limits and routing on port 8400;
`forge-service` provides metered model calls, generation streams, repair, direct and
outcome reporting on port 8410; `platform-service` keeps accounts and their profiles
(handles) in MariaDB on port 8430. Generation records currently live in memory. Saved
worlds, the showcase and the archive remain under development.

## Local development

Requirements: Java 21, Docker with Compose. Run from this folder:

```sh
docker compose -f compose.local.yaml up -d
./mvnw -B install -Dmaven.test.skip=true
```

In separate terminals, run the gateway, the mock service (no paid model calls) and the
platform service (its MariaDB is `compose.local.yaml`'s, on loopback 3316):

```sh
./mvnw -pl forge-gateway spring-boot:run -Dspring-boot.run.profiles=local
./mvnw -pl forge-service spring-boot:run -Dspring-boot.run.profiles=local,mock
./mvnw -pl platform-service spring-boot:run -Dspring-boot.run.profiles=local
```

PowerShell uses `.\mvnw.cmd`. If Java needs the Windows certificate store, set
`$env:MAVEN_OPTS='-Djavax.net.ssl.trustStoreType=Windows-ROOT'` first.

## Configuration and safety

`.env.example` lists configuration names and safe defaults. Supply real values via
environment variables or an operator-configured secret manager. Secret-manager
project links and credentials are not tracked. Keep the forge service behind the
gateway; local/mock profiles are development-only, not public deployment profiles.
The local gateway accepts development tokens only without Firebase credentials.
Use matching Firebase configuration on both sides for real sign-in.

Removing `mock` enables live model calls and spends credit: supply the API key
intentionally and review spend caps first. Redis persists counters on loopback 6390, and
the local MariaDB the platform's accounts on 3316, with non-secret local credentials.

Private docs, agent instructions and retained reports live in the separate
`wexy-notes` repository. Test sources, fixtures and smoke/mutation tools are tracked
with the application. The build above skips tests; it does not certify runtime
behavior. Run `./mvnw -B verify` for the default suite, or
`./mvnw -B clean verify -Predis-tests` for the strict gate with Docker running: the Redis
and MariaDB tests then run on Testcontainers instead of being skipped.
Runtime prompt Markdown, host rules and Maven wrapper distribution properties are tracked.

## Deploy

Images are built from the packaged jars by each module's `Dockerfile` (`forge-gateway`, `forge-service`,
`platform-service`). `bash deploy.sh` runs every test (`clean validate install -Predis-tests`, so Docker must be
running), then builds the three images, tags each with the next version (the registry's newest, its patch bumped)
and `latest`, and pushes the version, then `latest`. `bash deploy.sh forge-gateway` releases one image;
`WEXY_VERSION` sets the version, `WEXY_REGISTRY` the registry, and `WEXY_DRY_RUN=1` builds without pushing.

On the host, `compose.dev.yaml` (dev, on `latest`) and `compose.prod.yaml` (prod, pinned to a version) each
run Redis, the gateway and the service; `compose.platform.yaml` adds MariaDB and the platform service, and
`compose.tunnel.yaml` a Cloudflare tunnel, with every secret supplied as an environment variable by an
operator-run secret manager:

```sh
infisical run --env=dev -- docker compose -f compose.dev.yaml -f compose.platform.yaml -f compose.tunnel.yaml up -d
WEXY_IMAGE_TAG=0.0.5 infisical run --env=prod -- docker compose -f compose.prod.yaml -f compose.tunnel.yaml up -d
```

Without the platform file the accounts' routes answer 503 and nothing else changes; without the tunnel file
the stack has no public way in and is reached over SSH. `compose.records.yaml` adds the generation records'
schema once they ship. Only the tunnel reaches the internet:
the gateway is bound to the host's loopback and the services to the compose network. Health and
metrics answer on separate ports (8401, 8411, 8431) that the tunnel does not route. The `prod` profiles in
`src/main/resources` hold no secrets; the mock profile must never be active on a host.

## Attribution and licence

Gateway protection, authentication and money-control patterns derive from the
author's FlareLink backend; source headers record origins. The Maven wrapper is
Apache's. Project licence designation: MIT.
