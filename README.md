# Wexy

<p align="center">
  <img src="./wexy%20frontend/public/icon_full.svg" alt="Wexy — worlds, not videos" width="800">
</p>

**Describe a world. Watch it run on your graphics card. Film it.**

Wexy is a browser studio for living 3D worlds. Meta's models plan a world and write small GPU
functions; the browser checks the output before running it through NullGraph on the viewer's own
graphics card. The studio includes camera controls, still capture and video export in wide,
vertical and square formats.

Rendering happens on your device. Instructions for live generation are sent to the backend and
Meta's models; local rendering does not make the whole generation workflow offline or private.

## How it works

```text
Your idea → gateway → metered model calls → streamed plan and GPU functions
                                                    ↓
Film or photo ← browser studio ← verification on your device
```

- **Worlds, not pre-rendered clips.** The browser simulates and renders the world with WebGPU.
- **The host owns execution.** Models supply structured data and constrained WGSL function bodies,
  not arbitrary JavaScript or an unrestricted GPU command stream.
- **Check before replacing.** The existing world stays visible while a new build is checked;
  failures do not silently replace it with an unchecked result.
- **Capture in the studio.** NullGraph supplies the WebGPU runtime and browser film path;
  Mediabunny supports video capture.
- **Meter before calling.** The backend reserves spend before upstream requests and refuses when
  its meter is unavailable or a configured cap is reached. API credentials never belong in the browser.

## Repository layout

| Folder | Purpose | Stack |
| --- | --- | --- |
| `wexy frontend` | Studio, WebGPU runtime, verification, capture and model clients | TypeScript, Vite, NullGraph, Mediabunny, Firebase |
| `wexy backend/forge-common` | Shared service contracts | Java 21 |
| `wexy backend/forge-gateway` | Authentication, App Check, rate limits and routing | Spring Cloud Gateway |
| `wexy backend/forge-service` | Metered model calls, generation streams, agent turns and module authoring | Spring Boot, Redis |

Folder names contain spaces: quote them in shell commands. Tests, fixtures and executable
development harnesses are tracked. Private designs, work notes and retained local evidence live
in the separate `wexy-notes` repository and are not required to build the application.

## Getting started

### Requirements

- Node.js **24.12.0 or newer** and npm.
- **Java 21**; use the included Maven wrapper.
- Docker with Compose for local **Redis 7.2** and Redis-backed integration tests.
- Desktop Chrome or Edge with **WebGPU** for the studio. GPU support and resource limits depend
  on the browser, driver and graphics card.

### 1. Start the backend in mock mode

From the repository root:

```sh
cd "wexy backend"
docker compose -f compose.local.yaml up -d
./mvnw -B install -DskipTests
```

Then, in two separate terminals in `wexy backend`:

```sh
./mvnw -pl forge-gateway spring-boot:run -Dspring-boot.run.profiles=local
```

```sh
./mvnw -pl forge-service spring-boot:run -Dspring-boot.run.profiles=local,mock
```

The gateway listens on **8400**, the service on **8410**, and local Redis on loopback **6390**.
Mock mode requires no model API key and makes no paid model calls. These local profiles are for
development, not public deployment.

On PowerShell, replace `./mvnw` with `.\mvnw.cmd`. If Java needs the Windows certificate store,
set `$env:MAVEN_OPTS='-Djavax.net.ssl.trustStoreType=Windows-ROOT'` first.

### 2. Start the browser studio

In another terminal, from the repository root:

```sh
cd "wexy frontend"
npm ci
npm run dev
```

Open `http://localhost:5173/studio.html`; the landing page is at `http://localhost:5173`.
For local backend integration, set `VITE_API_ORIGIN=http://localhost:8400` in your environment
or an ignored `.env.local`. Leave Firebase values unset on both sides for the local development
identity; configure both sides together when enabling real sign-in.

See the [frontend README](./wexy%20frontend/README.md) and
[backend README](./wexy%20backend/README.md) for configuration and deployment details.

## Validation

From `wexy frontend`:

```sh
npm test                 # Headless contract, client and loop tests
npm run contrast         # Checks the configured color pairs
npm run build            # Type-checks and builds the static site in dist/
npm run verify           # All three, in sequence
```

From `wexy backend`:

```sh
./mvnw -B verify                      # Default suite; Docker-dependent tests may skip
./mvnw -B clean verify -Predis-tests   # Strict gate: Docker is required for Redis tests
```

Headless tests and a successful build do not establish GPU compatibility, visual quality or live
model behavior. Browser/GPU harnesses under `wexy frontend/dev` are separate checks; live-call
harnesses require intentional credentials and spend authorization.

## Configuration and safety

- Each application's `.env.example` lists configuration names and safe defaults, not credentials.
  Supply real secrets through environment variables or an operator-configured secret manager.
- Every `VITE_*` value can reach the browser bundle. Never put a model API key, Firebase service
  account, internal signing key or App Check debug token there.
- Keep `forge-service` behind the gateway. Do not expose local development-token authentication
  or mock profiles publicly.
- Removing the `mock` profile enables live model calls and can spend credit. Review keys, model
  configuration and spend caps before doing so.
- Do not commit `.env` files, service-account files, private keys or secret-manager project links.
  Runtime prompt Markdown, host rules and test fixtures are application resources and are tracked.

## Development status and boundaries

Wexy is under active development, not a finished general-purpose world-generation platform.

- **Available in source:** the studio, capture tools, plan/author/repair/direct/outcome routes,
  agent turns, module authoring, static candidate checks and program-revision clients. Developer
  view behind `?agent=1` includes module verdicts, evidence and candidate-bundle download.
- **Still being integrated:** device-level admission/execution for the engine-aware agent path.
  That path remains static-only; a checked candidate is not a claim that it has run successfully
  on a GPU.
- **Not complete:** durable generation records, the saved-world gallery and publishing. Current
  generation records are in memory; storage and sharing should not be assumed to survive a restart.
- **Device-dependent:** WebGPU execution and video export. There is no universal frame-rate,
  entity-count or capture-resolution guarantee.

Backend templates, manifests and frontend clients pin a shared contract. Deploy compatible builds
together; mismatched versions can be refused rather than silently accepted.

## Attribution

Wexy's studio and engine integration originated in the author's earlier playground. NullGraph is
the author's separately published WebGPU library. Gateway authentication, protection and
money-control patterns derive from the author's FlareLink backend; source headers record origins.
The Maven wrapper is Apache's. The application packages designate the project as MIT.