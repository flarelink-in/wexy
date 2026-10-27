# Wexy frontend

Worlds, not videos. Wexy's browser studio runs 3D worlds on the viewer's GPU and
captures films in wide, vertical or square formats. Model clients, a host function
contract and a verification loop are being integrated with the backend; the full
live browser path remains under development.

## Setup

Requirements: Node >=24.12.0 and desktop Chrome or Edge with WebGPU.

```sh
npm ci
npm run dev
npm run build
```

The dev server serves the landing page at `http://localhost:5173` and the studio at
`/studio.html`. Build type-checks the source and produces the static site in `dist/`.

Tests, contrast checks and GPU harnesses intentionally remain local, outside Git.
Therefore `npm test`, `npm run contrast` and `npm run verify` need those local files
and are not fresh-checkout commands. Build does not exercise a GPU or live calls.

## Backend and configuration

The sibling `wexy backend` folder contains the gateway and service. `.env.example`
lists public browser configuration names. Supply values as environment variables or
through your configured secret manager before starting Vite. Secret-manager project
links are not tracked.

For local integration, set `VITE_API_ORIGIN=http://localhost:8400`. Leave Firebase
values unset when using the backend's local development identity. For real Firebase
sign-in, configure both the browser and gateway; do not mix real tokens with a
dev-only gateway.

Every `VITE_*` value may reach the browser bundle. Never put the model API key,
Firebase service account, benchmark bearer or internal signing key there. The
backend owns paid model calls.

Private docs, agent instructions, tests and dev harnesses are excluded from Git,
but remain on the development machine. Embedded host rules are runtime resources
and are included with the application.

## Stack and attribution

Framework-free TypeScript and Vite; null-graph for WebGPU; mediabunny for MP4 capture;
Firebase Auth and App Check. The studio and engine originated in the author's
pre-existing playground. NullGraph is the author's separately published WebGPU
engine. Project licence designation: MIT.
