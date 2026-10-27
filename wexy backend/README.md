# Wexy backend

Java 21 services for the browser studio. `forge-common` holds shared contracts;
`forge-gateway` provides authentication, App Check, limits and routing on port 8400;
`forge-service` provides metered model calls, generation streams, repair, direct and
outcome reporting on port 8410. Records currently live in memory. Durable records,
the archive and published worlds remain under development.

## Local development

Requirements: Java 21, Docker with Compose. Run from this folder:

```sh
docker compose -f compose.local.yaml up -d
./mvnw -B install -Dmaven.test.skip=true
```

In separate terminals, run the gateway and mock service (no paid model calls):

```sh
./mvnw -pl forge-gateway spring-boot:run -Dspring-boot.run.profiles=local
./mvnw -pl forge-service spring-boot:run -Dspring-boot.run.profiles=local,mock
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
intentionally and review spend caps first. Redis persists counters on loopback 6390.

Private docs, agent instructions, test sources, smoke/mutation tools and reports
remain local and are excluded from Git. The build above packages the published
application without tests; it does not certify runtime behavior. Runtime prompt
Markdown, host rules and Maven wrapper distribution properties are tracked.

## Attribution and licence

Gateway protection, authentication and money-control patterns derive from the
author's FlareLink backend; source headers record origins. The Maven wrapper is
Apache's. Project licence designation: MIT.
