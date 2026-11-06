# Wexy frontend

Worlds, not videos. Wexy's browser studio runs 3D worlds on the viewer's GPU and
captures films in wide, vertical or square formats. Model clients, checked GPU function
contracts and verification connect the studio to the backend. The engine-aware agent creator
is the default; its checked build still requires device admission and the separate **Show it**
step. Developer view is available through `?agent=1`. The earlier creator (h1) was retired in EA9.6:
its hand-written examples and archives still play, with no model call.
Try the hosted build directly at **https://wexy.ai**, or see the root README for local setup.

## Setup

Requirements: Node >=24.12.0 and desktop Chrome or Edge with WebGPU.

```sh
npm ci
npm run dev
npm run build
```

The dev server serves the landing page at `http://localhost:5173` and the studio at
`/studio.html`. Build type-checks the source and produces the static site in `dist/`.

## Public HTML / Firebase Hosting

The landing page's content is already HTML. A small Firebase Functions v2 layer adds
environment-specific canonical, Open Graph and Twitter metadata on `/`, and serves
`/robots.txt` and `/sitemap.xml`. This is metadata rendering, **not application SSR**:
the studio, Firebase browser identity and all WebGPU execution remain client-side.
Only the homepage is listed in the sitemap; no unpublished profile/showcase API is assumed.

```sh
npm --prefix functions ci
npm run build:dev
npm run build
node --test test/public-html.test.mjs
npm --prefix functions run check
```

The frontend tools require Node >=24.12.0; the deployed Functions runtime is Node 22.
Use Node 22 for installing/checking Functions when matching the deployment runtime.
`functions/package-lock.json` pins the separate server dependencies. They are never
bundled into the browser. No service-account file or new secret is required by these
public-only handlers; they do not call the backend or weaken its authentication.

Builds retain `dist/` and `dist-dev/` for `vite preview`, and also produce deployment
artifacts `hosting-prod/` and `hosting-dev/`. Their landing templates are copied into
`functions/hosting/prod/` and `functions/hosting/dev/`. Do not deploy `dist` directly:
a static `index.html` takes priority over the root Function rewrite. `/index.html`
redirects to `/`; `/studio` still rewrites to the static studio. Unknown URLs and
missing assets remain 404s, not a misleading HTML fallback.

Dev uses `https://dev.wexy.ai`, with `noindex, nofollow` and robots disallowing all
crawling; production uses `https://wexy.ai`. These fixed origins cannot be poisoned by
request Host/query parameters. HTML is `no-store`, while hashed assets retain their
immutable cache policy. Hosting rewrites use `pinTag` so the Function revision and
the static asset release travel together. Hosting predeploy checks refuse a stale
template/asset pair. Keep each environment's browser configuration separate: run
`build:dev` with your dev public values and `build` with your prod public values.

For local Firebase routing checks after both builds:

```sh
firebase emulators:start --only hosting,functions --project wexy-bf8f8
```

This requires the Firebase CLI and Node 22 available locally. `npm run dev` and
`npm run preview` still serve the static Vite pages, not the metadata Functions.

**Deployment is a separate, billable operation, not part of building.** The Firebase
project must support Functions deployment (Blaze billing), and the CLI/user needs
the required Cloud Functions/Cloud Run/IAM permissions. Confirm the existing Hosting
target mappings before running a deploy. From the frontend directory, after building
with the correct environment values, the intended per-target commands are:

```sh
firebase deploy --only hosting:dev --project wexy-bf8f8
firebase deploy --only hosting:prod --project wexy-bf8f8
```

Because `pinTag` is enabled, these Hosting deployments also deploy the associated
Function. **They are not static-only uploads.** Do not deploy both targets just to
update one environment. No live deployment or billing configuration is performed by
the setup scripts. After deploying, check raw `/` HTML for the correct canonical,
`/robots.txt`, `/sitemap.xml`, `/studio`, a missing asset's 404, and response headers.

### GitHub Actions deployment

The repository-root `.github/workflows/firebase-hosting.yml` adapts FlareLink's
starter-vite-ts workflow for this monorepo. Pushes to `dev` deploy only dev; pushes
to `main` deploy only prod. `master` does not auto-deploy. Once the workflow is on
the repository's default branch, Actions > Firebase Hosting > Run workflow can
deploy dev manually (including from `master`). Manual prod runs require `main`.

Create these Actions secrets in this repository (or in the matching GitHub
environment). Use Wexy values, not the FlareLink starter's credentials:

| Secret | Value |
|---|---|
| `ENV_FILE` | Dev browser configuration: all seven `VITE_*` settings in `.env.example`, using the hosted HTTPS gateway, Firebase and App Check values |
| `GOOGLE_APPLICATION_CREDENTIALS` | Full JSON key for a dedicated Wexy dev deployment service account |
| `ENV_FILE_PROD` | Separate production browser configuration; never falls back to dev |
| `GOOGLE_APPLICATION_CREDENTIALS_PROD` | Full JSON key for a dedicated Wexy production deployment service account |

The deploy accounts must be authorized for Hosting **and** the pinned second-gen
Function/Cloud Run update, including acting as its runtime service account. A
Hosting-only account is insufficient. Do not reuse a backend runtime Admin SDK
key, commit JSON keys, or put server secrets in `ENV_FILE`: every `VITE_*` value
is public browser configuration. Rotate deployment keys according to your policy.

Configure GitHub environments named `dev` and `prod`; restrict `prod` to `main`
and add required reviewers where available. Only dev secrets are needed to start
with dev. The workflow installs locked dependencies, tests and builds the selected
environment under Node 24.12.0, then checks/deploys Functions under Node 22 using
Firebase CLI 15.11.0. It generates the ignored `.firebaserc` target mappings in CI
and serializes deployments across both environments. Do not run a local deploy
concurrently with CI. It deploys only `hosting:<target>`; `pinTag` carries the
matching renderer, not every Function. A successful dev run publishes the landing,
studio and agent-view links in its job summary. No PR or preview-channel deploys
are enabled, and this workflow does not deploy the backend.

Tests, fixtures, contrast checks and executable development harnesses are tracked.
Run `npm run verify` for the headless tests, contrast checks and production build.
Build does not exercise a GPU or live calls; browser/GPU harnesses are separate checks.

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

Private docs, agent instructions and retained local evidence live in the separate
`wexy-notes` repository. Tests and dev harnesses stay with the application.
Embedded host rules are runtime resources and are included with the application.

## Stack and attribution

Framework-free TypeScript and Vite; null-graph for WebGPU; mediabunny for MP4 capture;
Firebase Auth and App Check. The studio and engine originated in the author's
pre-existing playground. NullGraph is the author's separately published WebGPU
engine. Original Wexy material in this revision is source-available for evaluation under
`../license.md`, not MIT/open-source. Prior license grants and third-party licenses are
unaffected. See the root README for the full local evaluation and live-generation setup.
