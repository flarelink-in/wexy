// The Wexy studio: an idea -> the planner's draft -> the author's functions -> the verify ladder on this graphics
// card, with repair turns -> a live NullGraph world with controls, keyframes and MP4 export. The loop itself is
// src/loop (plain TypeScript); this file draws what it emits, swaps the world in once it has passed (L8), and
// reports the outcome. Worlds come from the backend's models (the live source) or from the playground's mock,
// and every world shows its source (design guidelines §3).
// Two views of one studio: the default speaks in plain words (Journey, Controls, the capture bar); Developer
// view, reached only by ?dev=1 (design guidelines §0), adds the technical log, the scene file, the WGSL editor
// and the GPU numbers.
// EA9.1 (agent-first-studio-design.md; Q114, Q115 and Q118 decided 2026-11-03): behind ?create=agent the idea box's
// Create is the agent's (src/loop/creation.ts): one turn, its modules and their repairs, then "Show it", the GPU go. The
// page without it is h1's, unchanged. ?agent=1's Developer-view panels watch the same controller (creation-path.ts).

import '@fontsource-variable/geist';
import '@fontsource-variable/unbounded';
import '@fontsource-variable/geist-mono';
import '../../styles/base.css';
import '../../styles/studio.css';

import { ARCHETYPES } from '../../forge-client/archetypes';
import type { ForgeClient, GenerationInfo, OutcomeReport, Source } from '../../forge-client/client';
import { readConfig } from '../../forge-client/config';
import { createApi, type Api } from '../../forge-client/http';
import { createIdentity } from '../../forge-client/identity';
import { createLiveClient } from '../../forge-client/live-client';
import { MockClient } from '../../forge-client/mock-client';
import { COLLISION_PROMPT } from '../../forge-client/examples/colliding-galaxies';
import { cameraPath, firstView, keyframeToView, viewToKeyframe, type CameraView } from '../../runtime/camera-path';
import { sceneFilm, snapshotLive, snapshotOf, sweepFilms, type FilmSource } from '../../capture/film';
import type { GateDiagnostic } from '../../verify/gate';
import { createLadder } from '../../verify/ladder';
import { RUNG_NAMES, runLoop, type LoopEvent, type LoopOutcome, type VerifyFailure, type Verifier } from '../../loop/machine';
import { COPY } from '../../loop/copy';
import { completeOutcome } from '../../loop/outcome';
import { SceneRuntime } from '../../runtime/scene-runtime';
import { MAX_LIVE_PIXELS, Viewport, type CameraMode } from '../../runtime/viewport';
import type { CompiledBody, ModuleCompiler } from '../../contract/adapters/bodies';
import type { DeepReadonly } from '../../contract/engine/frozen';
import type { SealedCandidate } from '../../loop/snapshot';
import { assembleModule } from '../../contract/host';
import { hookHeader } from '../../contract/wgsl';
import { $, download, h, isTyping } from '../../shared/dom';
import { fmtInt, fmtMs } from '../../shared/format';
import { highlightWgslLine } from '../../shared/highlight';
import { icon, loader, logo, wordmark } from '../../shared/icons';
import { formatJson } from '../../shared/json';
import { programText, QUALITY_UNIFORM, targetsOf, withProgramText, type ProgramTarget, type SceneSpec, type Style } from '../../contract/spec';
import { AccountSession, browserHint } from '../../platform/session';
import { AccountControl, creationAccount } from './account';
import { account as accountWorld, EMPTY, install as installWorld, uncounted, type ActiveWorld } from './active-world';
import { BACKDROP_DEFAULT, startBackdrop, type Backdrop } from './backdrop';
import { CodeView, type CodeMark } from './code-view';
import { DirectorPanel } from './director';
import { canShareFile, ExportDialog, shareFile } from './export-dialog';
import { formatById, FORMATS, frameSize, type FormatId } from './formats';
import { selectCreationPath, worldLink, type CreationPathSelection } from './creation-path';
import { Journey, type StageId } from './journey';
import { CREATIONS, SaveView } from './save-view';
import { SavedOpening } from './saved-opening';
import { stageTaken, type StageHolders } from './stage-holds';
import { Timeline } from './timeline';
import { TracePanel, type TraceStep } from './trace';

const STYLES: Array<{ value: Style | 'auto'; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'cosmic', label: 'Space' },
    { value: 'anime-cel', label: 'Anime' },
    { value: 'cinematic', label: 'Cinematic' },
    { value: 'brutalist', label: 'Brutalist' },
];
const LENGTHS = [6, 12, 20, 30];
/** The backend's cap on an idea (wexy.loop.caps.prompt-chars). */
const PROMPT_CHARS = 600;
/** The starters: the playground's three examples and host h1's two exemplar worlds, every one hand-written. */
const STARTERS: Array<{ id: string; label: string; prompt: string }> = [
    ...ARCHETYPES.map(a => ({ id: a.id, label: ({ 'kerr-black-hole': 'Black hole', 'celestial-torii': 'Sakura shrine', 'magnetic-star': 'Magnetar' })[a.id] ?? a.name, prompt: a.examplePrompt })),
    { id: 'galaxy', label: 'Galaxy', prompt: 'A spiral galaxy, gold at the core and blue along the arms, threaded with dark dust' },
    { id: 'collision', label: 'Colliding galaxies', prompt: COLLISION_PROMPT },
    { id: 'storm', label: 'Storm', prompt: 'A dark thunderstorm cloud that churns and turns in place while lightning flickers inside it' },
];
type Tab = 'director' | 'spec' | 'wgsl';
const lineCount = (s: string) => (s ? s.split('\n').length : 0);
/** A touch screen: the viewport zooms by pinching there, not by scrolling. */
const TOUCH = matchMedia('(pointer: coarse)').matches;

// The stage's Run (EA5.3), loaded only behind ?agent=1: its types, by name, so nothing of it is imported here.
type AgentStage = import('../../exec/stage').Stage;
type AgentReport = import('../../exec/stage').PrepareReport;
type AgentReservation = import('../../exec/gate').Reservation;
type AgentBounds = import('../../exec/bounds').WorldBounds;
type FrameWorld = typeof import('../../exec/bounds').frameWorld;
type RunSummary = import('./candidate-view').RunSummary;
type Sealed = DeepReadonly<SealedCandidate>;
type CreateFilmWorkload = import('null-graph/film').CreateFilmWorkload;
// The review of the stage (EA6), loaded only behind ?agent=1 too.
type AgentRuntimeT = import('../../exec/world-runtime').AgentRuntime;
type EnginePortT = import('../../exec/engine-port').EnginePort;
type ReviewCapture = typeof import('../../exec/review-capture');
type StageReviews = import('../../loop/review').StageReviews;
type StageCapture = import('../../loop/review').StageCapture;
type StageWorld = import('../../loop/review').StageWorld;
// The agent path's Create (EA9.1), loaded only behind ?create=agent or ?agent=1.
type CreationControllerT = import('../../loop/creation').CreationController;
type CreationViewT = import('./creation-view').CreationView;
type RunAbout = import('../../loop/creation').RunAbout;
// The creator's saved worlds (W3.6), loaded only on the agent path too: saving on install, and opening one by its id.
type SaveControllerT = import('../../platform/save-controller').SaveController;
type AccountFactsT = import('../../platform/save-controller').AccountFacts;
type OpenedWorldT = import('../../platform/open-saved').OpenedWorld;
/**
 * What a Run shows (W3.6): a creation's world (its title, S, whether it revises the one on the stage, and the caller its
 * Show it was pressed as), a saved world reopened (with the caller it was read as), or a saved attempt replayed. The
 * caller is the world's owner, whose account alone ever saves it (Q129).
 */
type RunOrigin = { readonly kind: 'creation'; readonly about: RunAbout; readonly ranAs: string | null } | { readonly kind: 'reopened'; readonly world: OpenedWorldT; readonly ranAs: string } | { readonly kind: 'replay' };
/**
 * An agent world on the stage (EA5.3): its runtime, its candidate, the device verdicts it was admitted on, and its
 * install's number, to which each film of it is bound (EA5.5); and what its Run found (its boxes, the probe's report),
 * which its review starts from (EA6). What it holds in the stage's ledger is H's (`World`'s `held`).
 */
interface AgentWorld {
    runtime: AgentRuntimeT;
    candidate: string;
    snapshot: Sealed;
    compiled: readonly DeepReadonly<CompiledBody>[];
    epoch: number;
    bounds: AgentBounds | null;
    report: AgentReport | null;
    /** The creation's title, from its idea (EA9.1); null for a saved attempt replayed, which Developer view names by id(C). */
    title: string | null;
    /** Where it came from (§8 step 6): a creation's turn is Live (its meta says so); a saved attempt replayed, the archive. */
    source: Source;
}

/** h1's world on the stage (§5's legacy variant): its runtime, its spec (the Director writes its moves into it), its source. */
interface LegacyWorld {
    readonly runtime: SceneRuntime;
    readonly spec: SceneSpec;
    readonly source: Source;
}

/**
 * H (I3; agent-first-studio-design.md §8, EA9.3): the one world on the stage, of one kind, with what it holds in the
 * stage's ledger. Only `put` changes which world it is (active-world.ts's install); `count` counts one built before the
 * stage existed.
 */
type World = ActiveWorld<LegacyWorld, AgentWorld, Backdrop>;

/** A Run's numbers in one line for Developer view: the probe's predictions, the reservation, the first frame's look. */
function runNumbers(report: AgentReport | null): string {
    const p = report?.probe;
    if (!report || !p) return report?.coverageWarning ?? '';
    const ms = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? 'not measured' : `${v.toFixed(1)} ms`);
    const parts = [`probe: init ${ms(p.initMs)}, step ${ms(p.computeMsPerFrame)}, frame ${ms(p.drawMsPerFrame)}`];
    if (report.coverageWarning) parts.unshift(report.coverageWarning);
    if (p.maxSubmissionMs !== undefined) parts.push(`worst submission ${ms(p.maxSubmissionMs)}`);
    if (p.caps) parts.push(`caps: init ${p.caps.init}, step ${p.caps.step}, frame ${p.caps.frame}, first frame ${p.caps.firstFrame} ms`);
    if (p.steadyFrameMs !== undefined) parts.push(`steady frame ${ms(p.steadyFrameMs)}`);
    parts.push(`reserved ${(report.reservation.total / 1e6).toFixed(0)} MB`);
    if (report.sanity && report.firstFrame) {
        parts.push(`first frame ${report.firstFrame.width}×${report.firstFrame.height}: visibility ${report.sanity.visibility}, ${report.sanity.sampled} floats sampled`);
    }
    parts.push(...(p.warnings ?? []));
    return parts.join(' · ');
}

/** A call's line in the technical log. A mock call made no request, so it has no model or tokens to show. */
function callMeta(g: GenerationInfo): string {
    if (g.source === 'mock') return `${fmtMs(g.ms)} · playground example, no model call`;
    const tokens = g.usage ? `${fmtInt(g.usage.in)} in / ${fmtInt(g.usage.out)} out${g.usage.reasoning ? ` (${fmtInt(g.usage.reasoning)} reasoning)` : ''}${g.usage.cached ? `, ${fmtInt(g.usage.cached)} cached` : ''}` : 'tokens unknown';
    const first = g.ttftMs === null ? '' : ` · first text ${fmtMs(g.ttftMs)}`;
    return `${fmtMs(g.ms)}${first} · ${g.model ?? 'model unknown'} · ${tokens}${g.promptVersion ? ` · ${g.promptVersion}` : ''}`;
}

class Studio {
    private viewport: Viewport | null = null;
    private ladder: Verifier<SceneRuntime> | null = null;
    private readonly mock = new MockClient({
        fault: new URLSearchParams(location.search).get('fault') === '1',
        autofix: new URLSearchParams(location.search).get('autofix') === '1',
    });
    /** The backend, when this build knows a gateway; otherwise every world is a playground example. */
    private live: ForgeClient | null = null;
    /** H, the one world on the stage (EA9.3): `runtime`, `spec`, `agentWorld` and `backdrop` each read it. */
    private world: World = EMPTY;
    /** Where the draft in the editor came from: the h1 world it was loaded with (h1's editor state, §5's LegacyDraft). */
    private draftSource: Source = 'mock';
    /**
     * The spec the editor's text belongs to, as last loaded. It differs from `spec` after a draft
     * fails the ladder: edits then belong to the new draft, not to the world still running.
     */
    private draftSpec: SceneSpec | null = null;
    /** True when the draft in the editor is the world that is running. */
    private draftIsLive = false;
    private duration = 12;
    private busy = false;
    private abort: AbortController | null = null;
    private calls: GenerationInfo[] = [];
    private texts: Partial<Record<ProgramTarget, string>> = {};
    private marks: Partial<Record<ProgramTarget, CodeMark[]>> = {};
    private activeTarget: ProgramTarget = 'evolve';
    private editedTargets = new Set<ProgramTarget>();
    private selectedKey = -1;
    private specTimer = 0;
    private lastHud = 0;
    private builds = 0;
    private devView = false;
    /** The shape photos and videos are made in; the capture bar and the export dialog share it. */
    private format: FormatId = 'wide';
    private guideOn = false;
    private toastTimer = 0;
    /** ?agent=1 only: L3 on this device (EA5.1), once the viewport's device exists; null without WebGPU. */
    private deviceCompiler: ModuleCompiler | null = null;
    /** The device's generation: it moves on a device loss, and evidence from before proves nothing (EA5). */
    private deviceGeneration = 0;
    private candidatePanel: { refresh(): void } | null = null;
    /** Which creation path the idea box runs, decided once from the URL (creation-path.ts, EA9.1). */
    private path: CreationPathSelection = selectCreationPath(new URLSearchParams(), { switched: false, gateway: false }, { unavailable: '', invalid: '' });
    /** The agent path's one owner of a creation (EA9.1, I1): behind ?create=agent or ?agent=1. */
    private creation: CreationControllerT | null = null;
    /** The creator's Create on the agent path (?create=agent): the idea box's button and the Journey. */
    private creationView: CreationViewT | null = null;
    /** Resolves once the stage (and its device compiler) exists: an agent Create waits for it, an autorun too. */
    private stageReady: Promise<void>;
    private markStageReady: () => void = () => {};
    /** Resolves once the creator's controls exist (mountCreation): an autorun waits for them too, whichever loads last. */
    private creationReady: Promise<void>;
    private markCreationReady: () => void = () => {};
    /** Who is signed in (W1, W2): the creation binds its calls to this session's epoch (§6). */
    private accountSession: AccountSession | null = null;
    /** ?agent=1 only: the review of the world on the stage (EA6.2), its panel beside the candidate. */
    private reviews: StageReviews | null = null;
    /** ?agent=1 only, with the stage: its engine's port and the review's capture, which draws the Head again offscreen (EA6.1). */
    private stagePort: EnginePortT | null = null;
    private reviewCapture: ReviewCapture | null = null;
    private encodeJpeg: ((rgba: Uint8Array, width: number, height: number, quality: number) => Promise<Uint8Array>) | null = null;
    /** ?agent=1 only: a saved attempt replayed through the stage's Run (11-02), compiled once the device compiler exists. */
    private replayPanel: { refresh(): void } | null = null;
    /** ?agent=1 only, once the viewport and its device compiler exist: the stage's Run (EA5.3). */
    private stage: AgentStage | null = null;
    /** ?agent=1 only, with the stage: an agent world's camera framed on what it built (bounds.ts, 11-02). */
    private frameWorld: FrameWorld | null = null;
    /** Agent worlds installed so far: each film of one is bound to its install (EA5.5). */
    private installs = 0;
    /** The agent world on the stage is paused past its envelope (EA_RESIZE), as the last frame saw it. */
    private agentPaused = false;
    /** ?agent=1, once the stage exists: a film's or a photo's workload of an agent world on the stage (EA5.5). */
    private agentFilm: ((world: AgentWorld, fps: number, still: CameraView) => CreateFilmWorkload) | null = null;
    /** The backdrop's frames, held while the device checks a candidate: released by a refusal, the run's end or the swap. */
    private backdropHold: (() => void) | null = null;
    /** The header's account control (W1): the allowance chip and Sign in; null without a live backend or a way to sign in. */
    private accountControl: AccountControl | null = null;
    /** The agent path's saves (W3.6): the creator's world saved once it is on the stage; null without a backend or an account. */
    private saves: SaveControllerT | null = null;
    /** Its status beside the world's title, and under the idea box where the header has none. */
    private saveView: SaveView | null = null;
    /** A saved world being opened by its id (W3.6), until a Run installs it or another world takes the stage. */
    private opening: SavedOpening | null = null;
    /** The empty stage's card's part for it. */
    private readonly openBlock = h('div', { class: 'empty-open', hidden: true });
    /** What that part shows: built again when it changes, its Show it's state read on every look. */
    private openShown = '';

    // Components and the elements they live in.
    private readonly trace = new TracePanel();
    private readonly journey = new Journey();
    private readonly director = new DirectorPanel();
    private readonly timeline = new Timeline();
    private readonly exporter = new ExportDialog();
    private readonly specView = new CodeView('json', false);
    private readonly wgslView = new CodeView('wgsl', true);
    private readonly prompt = h('textarea', { id: 'prompt', rows: '4', maxlength: String(PROMPT_CHARS), placeholder: 'Describe a world to simulate, light and film…', 'aria-label': 'Your idea' });
    private readonly style = h('select', { id: 'style', 'aria-label': 'Style' }, STYLES.map(s => h('option', { value: s.value }, s.label)));
    private readonly length = h('select', { id: 'length', 'aria-label': 'Video length' }, LENGTHS.map(s => h('option', { value: s, selected: s === 12 }, `${s} s`)));
    private readonly forgeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-forge', html: `${icon('spark', 16)}<span>Create world</span><kbd>Ctrl ⏎</kbd>` });
    private readonly sourceBadge = h('span', { class: 'badge badge-mock', id: 'source-badge' }, COPY.source.mock);
    private readonly tabs: Record<Tab, HTMLButtonElement> = {} as Record<Tab, HTMLButtonElement>;
    private readonly panels: Record<Tab, HTMLElement> = {} as Record<Tab, HTMLElement>;
    private readonly hookTabs = h('div', { class: 'hook-tabs', role: 'tablist', 'aria-label': 'Model-written code' });
    private readonly diagList = h('ul', { class: 'diag-list' });
    private readonly headerBox = h('pre', { class: 'host-header' });
    private readonly swapBtn = h('button', { type: 'button', class: 'btn btn-sm', disabled: true, html: `${icon('bolt', 13)}<span>Check &amp; hot-swap</span><kbd>Ctrl S</kbd>` });
    private readonly revertBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', disabled: true, html: `${icon('reset', 13)}<span>Revert</span>` });
    private readonly hud = {
        root: $('#hud'),
        mode: $('#hud-mode'),
        title: $('#hud-title'),
        source: $('#hud-source'),
        fps: $('#hud-fps'),
        res: $('#hud-res'),
        smooth: $('#hud-smooth'),
        cam: $('#hud-cam'),
        count: $('#hud-count'),
    };
    private readonly gate = $('#film-gate');
    private readonly gateFrame = $('#film-gate-frame');
    private readonly gateLabel = $('#film-gate-label');
    private readonly captureBar = $('#capture-bar');
    private readonly recordBtn = h('button', { type: 'button', class: 'cap-btn cap-record', title: 'Make a video (R)', html: '<i class="rec-dot"></i><span>Record</span>' });
    private readonly toast = $('#toast');
    private readonly empty = $('#empty');
    private readonly message = $('#viewport-msg');
    private readonly exportBtn = $('#btn-export') as HTMLButtonElement;
    private readonly snapBtn = $('#btn-snapshot') as HTMLButtonElement;

    constructor() {
        this.stageReady = new Promise(resolve => { this.markStageReady = resolve; });
        this.creationReady = new Promise(resolve => { this.markCreationReady = resolve; });
    }

    async init(): Promise<void> {
        $('#brand-logo').innerHTML = wordmark(22);
        const params = new URLSearchParams(location.search);
        const config = readConfig();
        // One identity for every client: Firebase starts once per page.
        const identity = config.apiOrigin ? createIdentity(config) : null;
        const api = identity ? createApi(config, identity) : null;
        if (api && params.get('source') !== 'mock') this.live = createLiveClient(api);
        // The account control (W1), for the live backend only: a playground example spends nothing and asks no one in.
        if (api && this.live && identity?.account) {
            // A Create with no caller yet makes its own first, through the transport's own lazy sign-in (EA9.1, §6 step 1).
            this.accountSession = new AccountSession(identity.account, browserHint, () => identity.authorization(false));
            this.accountControl = new AccountControl(this.accountSession, api, text => this.showToast(text, null), () => this.renderCreate());
            $('#btn-snapshot').before(this.accountControl.el);
            // W2: a browser that held a Google session shows its account at once; any other page view loads nothing.
            void this.accountControl.restore();
        }
        // ?create=agent, ?legacy=1, ?agent=1 and the loaders, resolved once (agent-first-studio-design.md §9).
        this.path = selectCreationPath(params, { switched: false, gateway: !!this.live },
            { unavailable: COPY.creation.noGateway, invalid: COPY.creation.invalid });
        const path = this.path;
        this.mountLeft();
        // On phones the allowance chip, and since W2 the handle and its claim, read as a line under the idea box, not in
        // the header (studio.css).
        if (this.accountControl) this.prompt.parentElement?.after(this.accountControl.line, this.accountControl.lineClaim);
        this.mountRight();
        $('#timeline-slot').replaceWith(this.timeline.el);
        this.mountEmpty();
        this.mountCaptureBar();
        this.wireTimeline();
        this.wireKeys();
        this.exportBtn.addEventListener('click', () => this.openExport());
        this.snapBtn.addEventListener('click', () => void this.takeSnapshot());
        this.setDevView(path.devView);
        // Before the GPU starts: a turn needs none, and runs on a device without WebGPU too.
        if (path.agentPath) void this.mountCreation(api);
        if (path.invalid) this.journey.say(path.invalid);
        else if (path.unavailable) this.journey.say(path.unavailable);
        this.exporter.onBusy = busy => {
            this.hud.mode.textContent = busy ? 'RECORDING' : 'LIVE';
            this.hud.root.classList.toggle('rendering', busy);
            document.body.classList.toggle('exporting', busy);
            // A Run waits while a film is made: Show it, readied meanwhile, is offered again once it ends (EA9.1's review).
            this.refreshRun();
        };
        new ResizeObserver(() => this.layoutFilmGate()).observe($('#viewport'));

        if (params.has('capture')) document.body.classList.add('capture');
        const starter = STARTERS.find(s => s.id === params.get('scene'));
        this.prompt.value = params.get('prompt') ?? starter?.prompt ?? STARTERS[0].prompt;
        this.prompt.dispatchEvent(new Event('input'));
        const format = params.get('format');
        if (format && FORMATS.some(f => f.id === format)) this.setFormat(format as FormatId, false);

        try {
            this.viewport = await Viewport.create($('#gpu-canvas') as HTMLCanvasElement);
        } catch (e) {
            this.showNoWebGPU((e as Error).message);
            return;
        }
        const vp = this.viewport;
        const ladder = createLadder(vp.engine, { width: () => vp.canvas.width, height: () => vp.canvas.height });
        // A check waits for the backdrop's build and holds its frames, so the probe times the candidate alone. A refusal
        // lets it play again while the model repairs; a pass keeps it held until the swap, so the canvas goes from the
        // backdrop straight to the new world (L6 draws its smoke frame on the canvas).
        this.ladder = {
            verify: async (spec, signal) => {
                if (this.backdrop) {
                    await this.backdrop.ready;
                    this.holdBackdrop();
                }
                try {
                    const result = await ladder.verify(spec, signal);
                    if (!result.ok) this.releaseBackdrop();
                    return result;
                } catch (error) {
                    this.releaseBackdrop();
                    throw error;
                }
            },
        };
        $('#gpu-pill').replaceChildren(h('i', { class: 'ok' }), h('span', null, vp.gpuLabel));
        $('#gpu-pill').title = 'The adapter WebGPU gave this page. On hybrid-GPU laptops Chrome may pick the integrated GPU: set Chrome to "High performance" in Windows graphics settings.';
        vp.onFrame = stats => this.onFrame(stats.fps, stats.width, stats.height, stats.quality, stats.scale);
        vp.onOrbitTakeover = () => this.setMode('orbit', false);
        vp.onDeviceLost = msg => {
            this.deviceGeneration++;
            // Every compile verdict and GPU go is void now (§9): a Run under way stops at its next check.
            this.stage?.goes.clear();
            this.creation?.deviceLost();
            this.showMessage(`Your graphics card stopped responding (${msg}). Reload the page to carry on.`, 'error');
        };
        // A photo's, a film's or a capture's hold: a Run waits for it, and is offered again once it ends (EA9.1). A Run's own
        // probe windows change nothing a control shows (the Run holds the stage throughout, and its end says so itself).
        if (path.agentPath) vp.onHold = () => { if (!this.stage?.busy) this.refreshRun(); };
        // A resize may grow what the world on the stage holds: counted again before any admission can read it (EA9.3's review).
        if (path.agentPath) vp.onRuntimeResized = () => this.count();
        if (path.agentPath) void this.mountDeviceCompiler(vp);
        if (params.has('rung')) vp.pin(Number(params.get('rung')));
        vp.start();
        // The empty stage's live backdrop, on either path: on the agent path its stage's ledger counts it (EA9.3), and a
        // Run's probe holds it still, as it holds any Head. ?backdrop=off keeps the still stage and the loader video;
        // ?backdrop=<id> picks another playground example.
        const backdrop = params.get('backdrop') ?? BACKDROP_DEFAULT;
        if (backdrop !== 'off') this.mountBackdrop(vp, backdrop);
        // Films a closed or crashed tab left in OPFS, and finished films no tab is showing (film.ts).
        void sweepFilms().then(removed => { if (removed.length) console.info(`Wexy: removed ${removed.length} old film(s) from this browser's storage`); });
        this.forgeBtn.disabled = false;
        this.renderCreate();

        if (path.create === 'agent') {
            // A loader calls no model: one of h1's hand-written examples by name, never a live h1 Create for a name this
            // build does not know (§9). An autorun is a Create, which still stops at "Show it" (I5); it waits for the stage.
            if (path.loader?.kind === 'scene' && starter) await this.forge('mock');
            // A saved world by its id (W3.6): read, sealed and compiled here, then Show it on the stage's card, the go.
            else if (path.loader?.kind === 'world') void this.openFromUrl(path.loader.name, api);
            else if (path.autorun) void Promise.all([this.stageReady, this.creationReady]).then(() => this.creationView?.create());
        } else if (!path.invalid && (params.has('autorun') || params.has('scene') || params.has('capture'))) {
            // A starter named in the URL is a playground example, whatever client this build has.
            await this.forge(starter || !this.live ? 'mock' : 'live');
        }
        if (params.has('t') && this.viewport) {
            this.seek(Number(params.get('t')));
            this.setPlaying(false);
        }
        if (params.has('guide') && this.runtime) this.setGuide(params.get('guide') !== '0');
    }

    /** The idea's three fields as the box holds them now (a turn's request, AgentTurnRequest). */
    private idea(): { prompt: string; style: Style | 'auto'; seconds: number } {
        return { prompt: this.prompt.value, style: this.style.value as Style | 'auto', seconds: this.duration };
    }

    /**
     * The agent path's Create (EA9.1): the one controller of a creation, behind ?create=agent (the idea box's Create) or
     * ?agent=1 (Developer view's panels, which watch the same one). Its code loads only then, so the plain page carries none
     * of it. It is handed the idea's fields, the device compiler, the stage's go and the account, never the world.
     */
    private async mountCreation(api: Api | null): Promise<void> {
        const [{ createCreationController }, { createAgentSession }, { createCandidateSession }, { createAgentClient }, { createModuleClient }, { createReviser }, { CreationView }] = await Promise.all([
            import('../../loop/creation'), import('../../loop/agent-turn'), import('../../loop/candidate'), import('../../forge-client/agent-client'),
            import('../../forge-client/module-client'), import('../../loop/reviser'), import('./creation-view'),
        ]);
        const client = api ? createAgentClient(api) : null;
        if (client && api) {
            const modules = createModuleClient(api);
            const revise = createReviser(client);
            const session = this.accountSession;
            const control = this.accountControl;
            this.creation = createCreationController({
                turnSession: onChange => createAgentSession(client, onChange),
                candidateSession: onChange => createCandidateSession({ modules, revise, compiler: () => this.deviceCompiler }, onChange),
                stage: {
                    blocked: () => this.runBlocked(),
                    go: (snapshot, compiled, about) => this.runCandidate(snapshot, compiled, about ? { kind: 'creation', about, ranAs: this.callerUid() } : { kind: 'replay' }),
                },
                account: session && control ? creationAccount(session, control) : undefined,
            });
            // W3.6: each world of the creator's saved once it is on the stage, for an account that can keep it.
            if (session && control) await this.mountSaves(api, session, control);
            // Q129: a world waiting for Show it is the account's that made it, so Sign out asks first; "Show it first" is
            // the creator's press of Show it, the GPU go.
            if (control) {
                control.unshownWorld = () => !!this.creation?.unshown;
                // The stage may be held (a film, a capture, a review's frame): then the press is said, not lost.
                control.showUnshown = () => {
                    if (this.creation?.showBlocked()) this.showToast(COPY.account.showFirstLater, null);
                    else void this.creation?.show();
                };
            }
            // Its paid work holds the account (Sign in and Sign out wait), and the empty stage says a world is being made.
            this.creation.subscribe(() => {
                this.accountControl?.setBusy(this.busy || !!this.creation?.busy);
                this.setBuilding(this.busy || !!this.creation?.busy);
            });
        }
        if (this.path.create === 'agent' && this.creation) {
            this.creationView = new CreationView(this.creation, {
                primary: this.forgeBtn,
                journey: this.journey,
                idea: () => {
                    const idea = this.idea();
                    if (idea.prompt.trim()) return { ...idea, prompt: idea.prompt.trim() };
                    this.prompt.focus();
                    return null;
                },
                blocked: () => this.createBlocked(),
                paused: () => !!this.agentWorld?.runtime.isPaused,
            });
            this.forgeBtn.after(this.creationView.again);
            this.showSourceBadge('live');
        }
        this.renderCreate();
        this.markCreationReady();
        if (this.path.agentPanels) await this.mountAgent(api);
    }

    /** Why the agent path's Create cannot start now, beyond the controller's own; null when it can. */
    private createBlocked(): string | null {
        if (this.path.unavailable) return this.path.unavailable;
        if (!this.viewport || !this.stage) return 'the stage is starting';
        if (this.busy) return 'an example is being built';
        return null;
    }

    /** The idea box's button as it stands: the creation view's on the agent path, h1's otherwise. */
    private renderCreate(): void {
        if (this.path.create === 'agent') {
            if (this.creationView) this.creationView.render();
            else this.forgeBtn.disabled = true;
            return;
        }
        // h1's Create waits for a Run too (?agent=1), shown whenever this runs, at the latest as the Run ends.
        this.forgeBtn.disabled = this.busy || !this.viewport || !!this.accountControl?.changing || !!this.stage?.busy;
    }

    /**
     * ?agent=1: the agent turn in Developer view (EA2.5), beside h1's own Create, which it leaves as it is until the
     * switch, and a hand-off's candidate beneath it (EA4.5: its modules written by the module route, a program revision by
     * a turn with a base). Since EA9.1 both watch the studio's creation controller, and their presses are presses on it.
     */
    private async mountAgent(api: Api | null): Promise<void> {
        const [{ AgentPanel }, { createAgentClient }] = await Promise.all([import('./agent-view'), import('../../forge-client/agent-client')]);
        const controller = this.creation;
        const panel = new AgentPanel(controller ? null : api ? createAgentClient(api) : null, () => this.idea(), {
            controller: controller ?? undefined,
            // The bundle carries the reviews of the attempt's stage and their frames (Q113 (a), EA6.4).
            candidate: controller ? { compiler: () => this.deviceCompiler, reviews: attempt => this.reviews?.bundled(attempt) ?? null } : undefined,
        });
        this.candidatePanel = panel.candidate;
        panel.el.classList.add('dev-only');
        $('#left').insertBefore(panel.el, this.trace.el);
        // A saved attempt replayed (11-02): `&replay=<name>` from the dev server's dev/replays, or a downloaded bundle
        // opened. Sealed and compiled here, then the same Run as a candidate's; no backend, so it needs no Api.
        const { ReplayPanel } = await import('./replay-view');
        const replay = new ReplayPanel({
            compiler: () => this.deviceCompiler,
            run: { blocked: () => this.runBlocked(), go: (snapshot, compiled) => this.runCandidate(snapshot, compiled, { kind: 'replay' }) },
        });
        this.replayPanel = replay;
        replay.el.classList.add('dev-only');
        $('#left').insertBefore(replay.el, this.trace.el);
        // The review of the world on the stage (EA6.2; Q109: Developer view only): captured after each install, the host's
        // findings, and the creator's "Looks right" or "Improve it" through the candidate session that holds that world.
        const [{ ReviewPanel, browserConsent }, { StageReviews }, { createReviewClient }] = await Promise.all([
            import('./review-view'), import('../../loop/review'), import('../../forge-client/review-client'),
        ]);
        let view: InstanceType<typeof ReviewPanel> | null = null;
        // A model's review (EA6.4): its terms read once a review is bound to a live session, its consent kept in this browser.
        const reviewer = api ? createReviewClient(api) : null;
        const reviews = new StageReviews({
            stage: () => this.stageWorld(),
            capture: (world, stale) => this.captureReview(world, stale),
            // The session holding the world on the stage (I8): H's, never a newer idea's; none for a replayed world.
            session: () => this.creation?.sessionFor(this.agentWorld?.candidate ?? null) ?? null,
            // While a new world is being made or waits for Show it, no paid action on this one (§6), which would strand it.
            paidBusy: () => (this.creation?.creating ? 'a new world is being made, or waits for Show it' : null),
            generation: () => this.deviceGeneration,
            busy: () => this.reviewBusy(),
            reviewer: () => reviewer,
            consent: browserConsent(),
            // Run waits while the stage is captured (runBlocked): every control that offers it is shown again as it ends.
            onChange: () => {
                view?.render();
                this.refreshRun();
            },
            onDrop: ids => view?.dropped(ids),
        });
        view = new ReviewPanel(reviews);
        // Its paid actions read the controller only as the panel renders (paidBusy, the stage's session), so the panel is
        // shown again whenever either changes: a new world made, waiting or let go, an account change, a device loss.
        let gate = '';
        this.creation?.subscribe(() => {
            const now = `${!!this.creation?.creating}|${!!this.creation?.sessionFor(this.agentWorld?.candidate ?? null)}`;
            if (now === gate) return;
            gate = now;
            view?.render();
        });
        this.reviews = reviews;
        view.el.classList.add('dev-only');
        $('#left').insertBefore(view.el, this.trace.el);
        const named = new URLSearchParams(location.search).get('replay');
        if (named !== null) void replay.loadNamed(named);
    }

    /** The agent world on the stage as its review sees it (EA6); null for an h1 world or none. */
    private stageWorld(): StageWorld | null {
        const w = this.agentWorld;
        if (!w) return null;
        const p = w.report?.probe;
        return {
            epoch: w.epoch, candidate: w.candidate, graph: w.snapshot.x.hash, gpu: this.viewport?.gpuLabel ?? 'unknown GPU',
            probe: p ? { warnings: p.warnings ?? [], width: p.viewport?.width ?? 0, height: p.viewport?.height ?? 0 } : null,
            unboxed: w.snapshot.x.nodes.filter(n => n.adapterId === 'ng.render.custom_batch').map(n => n.id),
        };
    }

    /** Why the stage cannot be captured for a review now: another owner holds it (a Run, a film, a photo). */
    private reviewBusy(): string | null {
        if (this.stage?.busy) return 'a Run is under way on this device';
        if (document.body.classList.contains('exporting')) return 'a film is being made';
        if (this.viewport?.held) return 'the stage is held by a photo, a film or a probe';
        return null;
    }

    /**
     * One capture of the agent world on the stage for its review (EA6.1; visual-review-design.md §6): its two views from
     * the framing of what it built (at the canvas's aspect now), drawn offscreen on the stage's engine while the viewport
     * holds still, read back with its boxes at that tick, fitted and encoded. The world stays on the stage whatever happens.
     */
    private async captureReview(world: StageWorld, stale: () => string | null): Promise<StageCapture> {
        const vp = this.viewport, w = this.agentWorld, port = this.stagePort, rc = this.reviewCapture, encode = this.encodeJpeg;
        const aspect = vp ? vp.canvas.width / Math.max(1, vp.canvas.height) : 1;
        const none = (message: string): StageCapture => ({ outcome: { ok: false, code: 'EA_CAPTURE', message }, missing: [], framed: null, aspect, prepared: null });
        if (!vp || !w || w.epoch !== world.epoch) return none('EA_CAPTURE stage: no agent world on the stage');
        if (!port || !rc || !encode) return none('EA_CAPTURE_UNAVAILABLE capture: the review\'s capture is still loading');
        const framing = this.frameWorld?.(w.bounds, vp.currentView().fov, aspect) ?? null;
        const { views, missing } = rc.reviewViews(framing, vp.currentView());
        const outcome = await rc.captureInstalled({
            port, runtime: w.runtime, x: w.snapshot.x, views, restoreHeadCamera: () => vp.writeCamera(), hold: () => vp.pause(), stale, ledger: this.stage?.ledger, encode,
        });
        return { outcome, missing, framed: views[0]?.camera ?? null, aspect, prepared: w.bounds };
    }

    /**
     * ?agent=1: L3 on this device (EA5.1). The compiler is handed the viewport's GPUDevice and nothing else; every body
     * it compiles passed L1 and L2 first, and compiling runs nothing on the GPU. Its code loads only then.
     */
    private async mountDeviceCompiler(vp: Viewport): Promise<void> {
        const [{ createDeviceCompiler }, stages, { createHeadlessPort, createNullGraphPort }, { limitsOf }, { adapterIdentity, environmentOf }, films, { frameWorld }] = await Promise.all([
            import('../../exec/device-compiler'), import('../../exec/stage'), import('../../exec/null-graph-port'), import('../../exec/gate'), import('../../exec/eligibility'),
            import('../../exec/film-workload'), import('../../exec/bounds'),
        ]);
        this.frameWorld = frameWorld;
        // The exact model, from the device's own adapter info. A browser that hides it matches no eligibility entry, which a
        // normal Run treats as advisory since 23d37da: EA_COVERAGE_UNVERIFIED warns and the probe decides (EA9.1's G5).
        const environment = environmentOf(adapterIdentity(vp.engine.device.adapterInfo), navigator.userAgent);
        const compiler = createDeviceCompiler(vp.engine.device, { generation: () => this.deviceGeneration, gpu: vp.gpuLabel });
        this.deviceCompiler = compiler;
        // The stage's Run (EA5.3): the viewport's engine, its device's limits, this device compiler's verdicts, the go from
        // Developer view, a reservation in one ledger with the Head's, and the switch: the viewport's setRuntime alone.
        // One port over the viewport's engine: the stage's, and the review's capture of what the stage installed (EA6.1).
        const port = createNullGraphPort(vp.engine);
        this.stagePort = port;
        this.stage = stages.createStage({
            port,
            headless: (width, height) => createHeadlessPort(vp.engine.device, width, height),
            limits: limitsOf(vp.engine.device),
            compiler: () => compiler,
            // κ: a new creation, a write, a cancel or a device loss stops a Run under way at its next check (EA9.1).
            present: { turn: () => this.creation?.n ?? 0, device: () => this.deviceGeneration },
            environment,
            gpu: vp.gpuLabel,
            size: () => ({ width: vp.canvas.width, height: vp.canvas.height }),
            maxPixels: MAX_LIVE_PIXELS,
            // G2 (EA9.2): a world is tested at what this screen can show, a phone's 0.74 MP rather than the 2.3 MP cap.
            display: () => stages.displayTarget(screen.width, screen.height, devicePixelRatio),
            view: () => vp.currentView(),
            restoreHeadCamera: () => vp.writeCamera(),
            // The Head holds while the probe times a submission, so its frames never land in the numbers (EA-E, 11-01).
            quiet: () => vp.pause(),
            commit: runtime => vp.setRuntime(runtime),
            now: () => performance.now(),
            onRefusal: message => this.trace.add('The agent world paused', 'gate').error(message),
        });
        // H built before the stage existed (h1's Head, or the backdrop) counted now, before any candidate is admitted.
        this.count();
        // Films and photos of an agent world (EA5.5; executor-design.md §9a): each built again on the film's own engine, through
        // the stage's gate, probe and look at the film's size, reserved beside the Head, on the verdicts the Head was admitted
        // on, and bound to its install and this device generation.
        const ledger = this.stage.ledger;
        this.agentFilm = (world, fps, still) => films.agentFilmWorkload(world.snapshot, {
            port: engine => createNullGraphPort(engine as Parameters<typeof createNullGraphPort>[0]),
            headless: (width, height) => createHeadlessPort(vp.engine.device, width, height),
            now: () => performance.now(),
            quiet: () => vp.pause(),
            limits: limitsOf(vp.engine.device), compiler: () => compiler, environment, gpu: vp.gpuLabel, ledger,
            present: { turn: () => this.agentWorld?.epoch ?? -1, device: () => this.deviceGeneration },
            onStage: () => this.agentWorld?.candidate ?? null,
            compiled: world.compiled,
            // Developer view's record of each film (and measurement) once disposed: its frames against time zero, and what
            // the stage's ledger holds after its release (EA-F2 reads both).
            onFrames: a => console.info(`Wexy: agent film ${a.candidate.slice(0, 12)}…, ${a.frames} frames at ${a.stepsPerFrame} step(s) a frame from time zero; frame 0 at step ${a.firstFrameSteps}; ${a.offTime} frame(s) off time; the stage's ledger holds ${ledger.held()} bytes`),
        }, { fps, still });
        this.candidatePanel?.refresh();
        this.replayPanel?.refresh();
        this.renderCreate();
        this.markStageReady();
        // The review's capture and the browser's JPEG encoder (EA6.1): loaded behind the stage, needed only once a world is on it.
        const [capture, { encodeJpeg }] = await Promise.all([import('../../exec/review-capture'), import('../../capture/jpeg')]);
        this.reviewCapture = capture;
        this.encodeJpeg = encodeJpeg;
    }

    /** Why Run cannot be pressed now; null when it can. It waits for every other holder of the stage (stage-holds.ts). */
    private runBlocked(): string | null {
        if (!this.viewport) return 'Run needs WebGPU, which this browser does not offer.';
        if (!this.stage) return 'The stage is starting: its device compiler loads first.';
        // No candidate is admitted beside a world the ledger does not count yet (§8 step 2): a backdrop still building.
        if (uncounted(this.world)) return this.world.kind === 'backdrop' ? 'The stage is starting: its backdrop is still loading.' : 'The stage is starting: the world on it is not counted yet.';
        return stageTaken(this.stageHolders());
    }

    /** What holds the stage now: a Run, an example's build, a review's capture, a film, any pause of the viewport. */
    private stageHolders(): StageHolders {
        // Any pause past the backdrop's own: its rest while scrolled out of sight holds nothing a Run's commit could race,
        // and on a phone it would keep Show it waiting while the creator types below the stage (EA9.3).
        const own = this.backdrop?.holdCount() ?? 0;
        return {
            running: !!this.stage?.busy, building: this.busy, capturing: !!this.reviews?.capturing,
            recording: document.body.classList.contains('exporting'), held: (this.viewport?.pauseCount ?? 0) > own,
        };
    }

    /**
     * The agent path's controls that offer a Run, shown again as they stand (the EA9.1 review): Show it, Run on this GPU
     * and a saved attempt's Run read who holds the stage only as they render, so each holder's start and end calls this.
     */
    private refreshRun(): void {
        if (!this.path.agentPath) return;
        this.renderCreate();
        this.candidatePanel?.refresh();
        this.replayPanel?.refresh();
        // A saved world waiting for its Show it reads the stage the same way (W3.6).
        this.renderOpening();
    }

    /**
     * The GPU go for this candidate, and its Run on the stage (Q89): the creation's "Show it" (its `about` names its world),
     * a saved world's Show it (W3.6), or a saved attempt's Run. An install sets the agent world's state.
     */
    private async runCandidate(snapshot: Sealed, compiled: readonly DeepReadonly<CompiledBody>[], origin: RunOrigin, signal?: AbortSignal): Promise<RunSummary> {
        const stage = this.stage;
        if (!stage) return { status: 'refused', reason: 'no stage here', numbers: '' };
        stage.press(snapshot);
        const step = this.trace.add('Run on this GPU', 'gate');
        // A creation's Show it names its world and is Live; a saved world reopened is its creation's, and like a saved
        // attempt it was made earlier, so it is From the archive ("made by Meta's models earlier and replayed here").
        const title = origin.kind === 'creation' ? origin.about.title : origin.kind === 'reopened' ? origin.world.title : null;
        const r = await stage.run(snapshot, compiled, signal);
        if (r.status === 'installed') {
            // The stage's commit has switched the viewport: H is set first, before anything that could throw, or a throw
            // would leave the world drawn owned by nobody and the old one counted (EA9.3's reviews).
            const notes = this.installAgent(r.runtime, r.held, snapshot, compiled, r.report, title, origin.kind === 'creation' ? 'live' : 'archive');
            // The world is on the stage from here: no step after the switch makes this Run a failure, so the controller
            // learns the world the stage shows.
            let said = notes.join(' · ');
            // The stage is free again: every control that offers a Run reads it now, a saved attempt's Run having no
            // creation to say so.
            this.afterSwitch('the controls that offer a Run', () => this.refreshRun());
            this.afterSwitch('the Run\'s numbers', () => { said = [runNumbers(r.report), ...notes].filter(Boolean).join(' · '); });
            this.afterSwitch('the Run\'s line', () => step.ok(said, `id(C) ${snapshot.id.slice(0, 12)}…`));
            // A saved attempt replayed, or a saved world reopened, is no creation's: the one that was on the stage lets its
            // session go (I8).
            if (origin.kind !== 'creation') this.afterSwitch('the replaced creation', () => this.creation?.replaced());
            // A reopened world's own camera, once it is framed (the companion §8 step 4: the view applies after).
            if (origin.kind === 'reopened' && origin.world.view) {
                const v = origin.world.view;
                this.afterSwitch('its saved view', () => this.viewport?.setView(keyframeToView({ t: 0, target: [...v.target], distance: v.distance, azimuth: v.azimuth, polar: v.polar, fov: v.fov })));
            }
            // Its save (W3.6, F8): a creation's world kept once it is here, the camera as it is now; a reopened one is its
            // saved head; a replay's is nobody's.
            this.afterSwitch('its save', () => this.saveInstalled(snapshot, origin));
            // Its review (EA6): captured now, as it is, from the framed view and the side.
            this.afterSwitch('its review', () => this.reviews?.installed(this.stageWorld()));
            return { status: 'installed', reason: null, numbers: said };
        }
        // Nothing switched: the stage is free again, and every control that offers a Run reads it now.
        this.refreshRun();
        const numbers = runNumbers(r.report);
        step.error(r.reason, numbers);
        return { status: r.status, reason: r.reason, numbers };
    }

    // ------------------------------------------------------------------ the world on the stage (EA9.3, I3)

    /** h1's world on the stage (H's legacy variant), or null. */
    private get runtime(): SceneRuntime | null {
        return this.world.kind === 'legacy' ? this.world.legacy.runtime : null;
    }

    /** The running h1 world's spec: the Director's moves are written back into it. */
    private get spec(): SceneSpec | null {
        return this.world.kind === 'legacy' ? this.world.legacy.spec : null;
    }

    /** The agent world on the stage (H's agent variant), or null. */
    private get agentWorld(): AgentWorld | null {
        return this.world.kind === 'agent' ? this.world.agent : null;
    }

    /** The empty stage's live backdrop (backdrop.ts) until the first world replaces it (H's backdrop variant), or null. */
    private get backdrop(): Backdrop | null {
        return this.world.kind === 'backdrop' ? this.world.backdrop : null;
    }

    /**
     * `next` onto the stage in place of H, the one way a world reaches it (active-world.ts's install; §8 step 1): the switch
     * (`commit`; none after an agent Run, whose stage made it), H set and the new world's page published in the same
     * synchronous handover, then the old world retired, whatever its kind: its destroy attempted, its reservation returned
     * once. A teardown's error is said, and the new world stays.
     */
    private put(next: World, commit: (() => void) | null, publish: () => void): void {
        const { errors } = installWorld(this.world, next, {
            ...(commit ? { commit } : {}),
            publish: w => {
                this.world = w;
                publish();
            },
            destroy: old => this.destroyWorld(old),
        });
        for (const error of errors) {
            // A switch that did not happen, or a new world's page left part-written, is a fault: the console says so too.
            if (/^EA_(COMMIT|PUBLISH) /.test(error)) console.error(`Wexy: ${error}`);
            this.afterSwitch('its log', () => this.trace.add(error.startsWith('EA_COMMIT') ? 'The switch' : error.startsWith('EA_PUBLISH') ? 'The new world\'s page' : 'The old world\'s cleanup', 'gate').error(error));
        }
        // Developer view's record of each change of world, and what the stage's ledger holds after it (EA9-E2 reads both).
        console.info(`Wexy: on the stage: ${this.worldName()}${this.ledgerLine()}`);
        if (this.world === next) {
            // W3.6: only an agent world has a save to say (its own install says it, saveInstalled); for any other, the line
            // goes. A world reaching the stage ends a saved world's opening: the creator chose another (it reopens from
            // the history), or it is the one opened.
            if (next.kind !== 'agent') this.afterSwitch('the save line', () => { this.saves?.cleared(); this.saveView?.render(null); });
            if (next.kind === 'agent' || next.kind === 'legacy') this.afterSwitch('the opening', () => this.endOpening());
        }
    }

    /**
     * One step after a world is on the stage: whatever it does, the world stays, and the caller goes on as installed. A
     * throw is said in the console, never thrown (EA9.3's review: a throw after the switch read as a failed Run).
     */
    private afterSwitch(what: string, step: () => void): void {
        try {
            step();
        } catch (error) {
            console.error(`Wexy: after the switch, ${what} failed; the world on the stage stays`, error);
        }
    }

    /** H in a few words, for the console: its kind and its title or id. */
    private worldName(): string {
        const w = this.world;
        if (w.kind === 'legacy') return `legacy "${w.legacy.spec.title}"`;
        if (w.kind === 'agent') return `agent "${agentTitle(w.agent)}" #${w.agent.epoch}`;
        if (w.kind === 'backdrop') return `backdrop ${w.backdrop.id}`;
        return 'nothing';
    }

    /** What the stage's ledger holds, for the console; nothing before the stage exists. */
    private ledgerLine(): string {
        const ledger = this.stage?.ledger;
        return ledger ? `; the stage's ledger holds ${ledger.held()} bytes: ${ledger.holders().map(h => h.label).join(', ') || 'nothing'}` : '';
    }

    /** An old world's teardown after the switch (L8), by its kind. Its reservation is install's to return. */
    private destroyWorld(old: World): void {
        if (old.kind === 'legacy') old.legacy.runtime.destroy();
        else if (old.kind === 'agent') old.agent.runtime.destroy();
        else if (old.kind === 'backdrop') {
            // Its holds let go, then it is freed; the switch has taken its place on the viewport.
            this.releaseBackdrop();
            old.backdrop.drop();
            this.empty.classList.remove('has-backdrop');
        }
    }

    /**
     * H counted in the stage's ledger (§8 step 2): h1's Head or the backdrop, built before the stage was, once both exist;
     * at the largest canvas the viewport ever gives a world, its live cap (`MAX_LIVE_PIXELS`), so no resize outgrows its
     * reservation, a page zoom's or another display's included; and again, larger, should it ever (a path past the cap,
     * such as dev/smoke's `enterExport`), right after the resize (EA9.3's reviews). A backdrop still building is counted
     * once it is on the viewport; until then no candidate is admitted (runBlocked).
     */
    private count(): void {
        const w = this.world;
        const ledger = this.stage?.ledger ?? null;
        const [bytes, now, label] = w.kind === 'legacy' ? [w.legacy.runtime.deviceBytesAt(MAX_LIVE_PIXELS), w.legacy.runtime.deviceBytes, `head: ${w.legacy.spec.title}`]
            : w.kind === 'backdrop' ? [w.backdrop.bytes(MAX_LIVE_PIXELS), w.backdrop.bytes(0), `backdrop: ${w.backdrop.id}`] : [null, null, ''];
        this.world = accountWorld(w, bytes, ledger ? (l, b) => ledger.record(l, b) : null, label);
        if (this.world !== w) console.info(`Wexy: counted on the stage: ${this.worldName()}, at its largest canvas (it holds ${now} bytes now)${this.ledgerLine()}`);
    }

    /**
     * An agent world on the stage (EA5.3; executor-design.md §5), through `put`. The switch was the stage's commit (the
     * viewport's setRuntime); the old world, whatever its kind, is retired after this one is published.
     */
    private installAgent(runtime: AgentRuntimeT, held: AgentReservation, snapshot: Sealed, compiled: readonly DeepReadonly<CompiledBody>[], report: AgentReport | null, title: string | null, source: Source): string[] {
        const agent: AgentWorld = { runtime, candidate: snapshot.id, snapshot, compiled, epoch: ++this.installs, bounds: report?.bounds ?? null, report, title, source };
        let notes: string[] = [];
        this.put({ kind: 'agent', agent, held }, null, () => { notes = this.publishAgent(agent); });
        return notes;
    }

    /**
     * An agent world's page (§8 steps 3 to 7). h1's draft no longer runs, and what an agent world has not got yet is off:
     * keyframes and the camera path (W has none) and the Director (Q85). Films and photos are on (EA5.5): each made from
     * its candidate again, from time zero, with the camera where it is. Its framing's notes, for Developer view.
     */
    private publishAgent(w: AgentWorld): string[] {
        const vp = this.viewport!;
        const { bounds, snapshot, title } = w;
        this.draftIsLive = false;
        this.selectedKey = -1;
        this.setMode('orbit', true);
        // A program has no camera of its own yet: the orbit is framed on what the world built, its mesh batches as init
        // left them (bounds.ts), or starts where the orbit always starts. The old world's view is never inherited.
        const fov = vp.currentView().fov;
        const framing = this.frameWorld?.(bounds, fov, vp.canvas.width / Math.max(1, vp.canvas.height)) ?? null;
        vp.setView(framing?.view ?? { target: [0, 0, 0], distance: 12, azimuth: 0, polar: 1.25, fov });
        vp.path = null;
        this.timeline.setKeyframes([]);
        this.director.note(this.agentControlsNote());
        this.exportBtn.disabled = false;
        this.snapBtn.disabled = false;
        this.captureBar.hidden = false;
        this.empty.hidden = true;
        this.hud.root.hidden = false;
        this.hud.title.textContent = agentTitle(w);
        // The header names a creation's world as h1's plan names its own (EA9.1); a replayed attempt leaves it as it was.
        if (title !== null) $('#scene-title').textContent = title;
        // Its source, in today's three words (§8 step 6): Live for a creation's, From the archive for a saved attempt's.
        this.hud.source.textContent = COPY.source[w.source];
        this.hud.source.title = COPY.sourceTitle[w.source];
        this.hud.source.hidden = false;
        this.showSourceBadge(w.source);
        // Developer view's numbers only: the creator's view names no node or module (§2's P5).
        this.hud.count.textContent = this.devView ? `${snapshot.x.nodes.length} nodes · ${snapshot.interfaces.length} modules` : '';
        this.swapBtn.disabled = this.busy || !this.draftSpec;
        return framing?.notes ?? [];
    }

    // ------------------------------------------------------------------ saved worlds (W3.6)

    /**
     * The saves (W3.6; the creations platform companion §7, F8): the controller over the platform's world calls, told who
     * is signed in (E_auth, and whether that account can keep a world), and its status beside the world's title. The
     * account's word reaches it whenever its epoch or its standing changes, once each: a sign-in moves the epoch, then the
     * account's read makes it active, and a world waiting for an account is saved then.
     */
    private async mountSaves(api: Api, session: AccountSession, control: AccountControl): Promise<void> {
        const { createSaveController } = await import('../../platform/save-controller');
        const view = new SaveView({
            // An account not read yet (its read failed, or is under way): Try again reads it, and its read saves the world
            // waiting for it; any other: the same request again (the independent review).
            retry: () => {
                if (session.current.kind === 'google' && control.saveKind === 'unknown') void control.afterEntry();
                else void this.saves?.retry();
            },
            saveAsNew: () => void this.saves?.saveAsNew(),
            openSaved: worldId => this.openSavedOne(worldId),
            signIn: () => control.signInToSave(),
        });
        $('#scene-title').after(view.el);
        control.lineClaim.after(view.line);
        const facts = (): AccountFactsT => {
            const s = session.current;
            return {
                epoch: s.epoch, kind: s.kind === 'anonymous' ? 'anonymous' : s.kind === 'google' ? control.saveKind : 'unknown',
                // The caller this epoch's saves go out as, and no other (W3's review).
                caller: session.caller(),
            };
        };
        this.saves = createSaveController({
            api, account: facts, newKey: () => crypto.randomUUID(), wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
            // Only the world on the stage's save is said: the controller speaks of its current one alone (cleared()).
            changed: state => { if (this.agentWorld) view.render(state); },
        });
        this.saveView = view;
        let heard = `${facts().epoch}|${facts().kind}`;
        const moved = () => {
            const f = facts();
            const now = `${f.epoch}|${f.kind}`;
            if (now === heard) return;
            heard = now;
            this.saves?.accountChanged();
        };
        session.subscribe(moved);
        control.onAccount = moved;
    }

    /** The caller signed in now, as the session knows it (its uid), or null: who a creation's Show it was pressed as. */
    private callerUid(): string | null {
        return this.accountSession?.caller()?.uid ?? null;
    }

    /** H's save, as its Run installed it (F8): a creation's world from now, a reopened one as saved, a replay's none. */
    private saveInstalled(snapshot: Sealed, origin: RunOrigin): void {
        const saves = this.saves, w = this.agentWorld;
        if (!saves || !w) return;
        if (origin.kind === 'creation') {
            const { about } = origin;
            saves.installed({
                stage: w.epoch, source: 'live', snapshot, design: about.design, view: this.viewport?.currentView() ?? null,
                title: about.title.trim() || 'Untitled world',
                // A version of the creation's world on the stage continues its save, under the install the controller
                // knows that world by (the same world shown again keeps its first install's there).
                improves: about.revises ? saves.state()?.stage ?? null : null,
                // Whose world it is: the caller its Show it was pressed as (the second review of W3).
                ranAs: origin.ranAs,
            });
        } else if (origin.kind === 'reopened') {
            const o = origin.world;
            saves.installed({
                // Its camera as it shows now, its saved view applied: kept should the creator save it again (the review).
                stage: w.epoch, source: 'reopened', snapshot, design: o.design, view: this.viewport?.currentView() ?? null, title: o.title, improves: null,
                // Its owner, the caller it was read as: under another account it stays here, never saved there (Q129).
                ranAs: origin.ranAs,
                saved: { worldId: o.worldId, revisionId: o.revisionId, rowVersion: o.rowVersion },
            });
        } else {
            saves.installed({ stage: w.epoch, source: 'archive', snapshot, design: null, view: null, title: '', improves: null });
        }
    }

    /**
     * A saved world opened by its id (`?world=<id>`; W3.6, the companion §8): saved-opening.ts reads who is signed in,
     * then the world (open-saved.ts, as that epoch's caller alone), compiles it by L3 on this device, and offers it on the
     * empty stage's card, whose Show it is the GPU go. Only the world routes are called for it, never a model (F5). The
     * world on the stage stays until the Run installs this one; any account change after the read ends the opening, so a
     * world read for one account is never installed for another (F4; W3's review, its mid).
     */
    private async openFromUrl(worldId: string, api: Api | null): Promise<void> {
        const session = this.accountSession && this.accountControl ? this.accountSession : null;
        const opening: SavedOpening = new SavedOpening(worldId, {
            api, session,
            open: async (bound, id) => (await import('../../platform/open-saved')).openSaved(bound, id),
            // L3 on this device: the stage's device compiler, once the stage exists.
            compile: async world => {
                const { compileSaved } = await import('../../loop/replay');
                await this.stageReady;
                const compiler = this.deviceCompiler;
                if (!compiler) return { problem: 'no device compiler here' };
                try {
                    const compiled = await compileSaved(world.snapshot, compiler);
                    const refused = compiled.filter(c => !c.ok).map(c => c.module);
                    return refused.length ? { problem: `L3 refused ${refused.join(', ')} on this device` } : { compiled };
                } catch (e) {
                    return { problem: `L3 could not run: ${(e as Error)?.message ?? e}` };
                }
            },
            blocked: () => this.runBlocked() !== null,
            run: async (ready, readAs, signal) => {
                const summary = await this.runCandidate(ready.world.snapshot, ready.compiled, { kind: 'reopened', world: ready.world, ranAs: readAs }, signal);
                return summary.status === 'installed' ? 'installed' : summary.status === 'stopped' ? 'stopped' : 'refused';
            },
            changed: () => { if (this.opening === opening) this.renderOpening(); },
            record: (ok, text) => {
                const step = this.trace.add('A saved world', 'gate');
                if (ok) step.ok(text);
                else {
                    console.warn(`Wexy: the saved world ${worldId} did not open: ${text}`);
                    step.error(text);
                }
            },
        });
        this.opening?.end();
        this.opening = opening;
        this.renderOpening();
        await opening.start();
    }

    /** The creator's Show it for the saved world opened: the GPU go, then the stage's Run, as for any world (Q115). */
    private async showOpened(): Promise<void> {
        await this.opening?.show();
    }

    /** The empty stage's card's part for a saved world being opened: where it stands, and Show it once it is ready. */
    private renderOpening(): void {
        const o = this.opening?.view() ?? null;
        const block = this.openBlock;
        const key = o ? `${o.worldId}|${o.sentence}|${o.offer}|${o.ready}` : '';
        if (key !== this.openShown) {
            this.openShown = key;
            block.hidden = !o;
            block.replaceChildren();
            if (o) {
                block.append(h('p', { class: 'empty-open-text', role: 'status' }, o.sentence));
                const actions = h('div', { class: 'empty-open-actions' });
                if (o.ready) {
                    const show = h('button', { type: 'button', class: 'btn empty-open-show' }, COPY.open.show);
                    // A double click is one press (gotchas: a button whose action turns as it is pressed).
                    show.addEventListener('click', e => { if (e.detail <= 1) void this.showOpened(); });
                    actions.append(show);
                }
                if (o.offer === 'sign-in') {
                    const signIn = h('button', { type: 'button', class: 'btn' }, COPY.account.signIn);
                    signIn.addEventListener('click', () => this.accountControl?.signInToSave());
                    actions.append(signIn);
                }
                if (o.offer === 'your-worlds') actions.append(h('a', { class: 'btn btn-quiet', href: CREATIONS }, COPY.save.yourWorlds));
                if (actions.children.length) block.append(actions);
            }
        }
        // Show it waits, as every Run does, for every other holder of the stage (stage-holds.ts).
        const show = block.querySelector<HTMLButtonElement>('.empty-open-show');
        if (show) {
            const blocked = this.runBlocked();
            show.disabled = blocked !== null;
            show.title = blocked ?? COPY.open.show;
        }
    }

    /** A world reached the stage: a saved world's opening is over, whichever world it was (W3.6). */
    private endOpening(): void {
        if (!this.opening) return;
        this.opening.end();
        this.opening = null;
        this.renderOpening();
    }

    /** "Open the saved one" after a conflict (the companion §7): the saved head, once the creator confirms this world goes. */
    private openSavedOne(worldId: string): void {
        if (!window.confirm(COPY.save.openSavedConfirm)) return;
        location.assign(worldLink(worldId));
    }

    /**
     * Plain words always; Developer view (the code, the spec, the numbers) only for ?dev=1. It is not part of
     * the product, so nothing links to it and nothing remembers it (design guidelines §0, Q16).
     */
    private setDevView(on: boolean): void {
        this.devView = on;
        document.body.classList.toggle('dev', on);
        if (!on) this.selectTab('director');
    }

    // ------------------------------------------------------------------ layout

    private mountLeft(): void {
        const examples = h('div', { class: 'examples-chips' }, STARTERS.map(s => {
            const b = h('button', { type: 'button', class: 'chip', title: s.prompt }, s.label);
            b.addEventListener('click', () => this.starter(s.prompt));
            return b;
        }));
        this.forgeBtn.disabled = true;
        // On the agent path the creation view owns this button's press (creation-view.ts): Create world, Stop or Show it.
        this.forgeBtn.addEventListener('click', () => {
            if (this.path.create !== 'agent') void this.forge(this.live ? 'live' : 'mock');
        });
        this.length.addEventListener('change', () => this.setDuration(Number(this.length.value)));
        this.sourceBadge.title = COPY.sourceTitle.mock;
        const card = h('section', { class: 'prompt-card' },
            h('header', { class: 'panel-head' }, h('h2', null, 'Your idea'), this.sourceBadge),
            h('div', { class: 'prompt-box' }, this.prompt, h('div', { class: 'prompt-tools' }, h('span', { class: 'prompt-count dev-only' }))),
            h('div', { class: 'examples' }, h('span', { class: 'examples-label' }, 'Try'), examples),
            h('div', { class: 'prompt-row' },
                h('label', { class: 'select' }, h('span', null, 'Style'), this.style),
                h('label', { class: 'select' }, h('span', null, 'Video length'), this.length),
            ),
            this.forgeBtn,
        );
        const counter = card.querySelector('.prompt-count') as HTMLElement;
        const count = () => { counter.textContent = `${this.prompt.value.length} / ${PROMPT_CHARS}`; };
        this.prompt.addEventListener('input', count);
        count();
        this.journey.el.classList.add('simple-only');
        this.trace.el.classList.add('dev-only');
        $('#left').append(card, this.journey.el, this.trace.el);
        this.showSourceBadge(this.live ? 'live' : 'mock');
    }

    /**
     * A starter: one of h1's hand-written examples, built over the mock, no model called. On the agent path it waits while a
     * creation is under way: the two would share the stage and the steps.
     */
    private starter(prompt: string): void {
        if (this.creation?.busy) return;
        this.prompt.value = prompt;
        this.prompt.dispatchEvent(new Event('input'));
        void this.forge('mock');
    }

    /** The badge beside the idea: what the next Create does, then what the running world is. */
    private showSourceBadge(source: Source): void {
        this.sourceBadge.textContent = COPY.source[source];
        this.sourceBadge.title = COPY.sourceTitle[source];
        this.sourceBadge.className = `badge badge-${source}`;
    }

    private mountRight(): void {
        // Only Developer view has more than one tab, so only it shows the tab bar.
        const nav = h('nav', { class: 'tabs dev-only', role: 'tablist' });
        const defs: Array<[Tab, string, 'sliders' | 'braces' | 'code']> = [['director', 'Controls', 'sliders'], ['spec', 'Spec', 'braces'], ['wgsl', 'WGSL', 'code']];
        for (const [tab, label, ic] of defs) {
            const b = h('button', { type: 'button', role: 'tab', id: `tab-${tab}`, 'aria-controls': `panel-${tab}`, html: `${icon(ic, 14)}<span>${label}</span>` });
            b.addEventListener('click', () => this.selectTab(tab));
            this.tabs[tab] = b;
            nav.append(b);
        }
        this.panels.director = h('div', { class: 'tab-panel', id: 'panel-director', role: 'tabpanel' }, this.director.el);

        const copy = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', html: `${icon('copy', 13)}<span>Copy</span>` });
        copy.addEventListener('click', () => { if (this.spec) void navigator.clipboard.writeText(formatJson(this.spec)); });
        const save = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', html: `${icon('download', 13)}<span>spec.json</span>` });
        save.addEventListener('click', () => { if (this.spec) download(new Blob([formatJson(this.spec)], { type: 'application/json' }), 'world.spec.json'); });
        this.panels.spec = h('div', { class: 'tab-panel', id: 'panel-spec', role: 'tabpanel' },
            h('div', { class: 'tab-toolbar' }, h('span', { class: 'muted ellipsis' }, 'SceneSpec 2.0 · host h1'), h('span', { class: 'grow' }), copy, save),
            this.specView.el);
        this.specView.setText('// The plan appears here as the planner writes it.');

        this.wgslView.onSave = () => void this.hotSwap();
        this.wgslView.onChange = text => {
            this.texts[this.activeTarget] = text;
            this.editedTargets.add(this.activeTarget);
            this.marks[this.activeTarget] = [];
            this.swapBtn.disabled = this.busy || !this.draftSpec;
            this.revertBtn.disabled = false;
            this.renderTargetTabs();
        };
        this.swapBtn.addEventListener('click', () => void this.hotSwap());
        this.revertBtn.addEventListener('click', () => this.revert());
        const headerDetails = h('details', { class: 'host-details' }, h('summary', null, 'Host module · what the host wraps around this text'), this.headerBox);
        this.panels.wgsl = h('div', { class: 'tab-panel', id: 'panel-wgsl', role: 'tabpanel' },
            h('div', { class: 'tab-toolbar' }, this.hookTabs),
            headerDetails, this.wgslView.el, this.diagList,
            h('div', { class: 'tab-actions' }, h('span', { class: 'muted ellipsis grow' }, 'Edits go through the same ladder'), this.revertBtn, this.swapBtn));
        this.wgslView.setText('// The author writes three functions: evolve (motion), look (color, size, opacity) and sky.\n// Edit any of them, then check and hot-swap with Ctrl+S.');
        this.wgslView.setEditable(false);
        this.renderTargetTabs();

        const head = h('header', { class: 'controls-head simple-only' }, h('h2', null, 'Shape it'), h('span', null, 'Changes show up instantly'));
        $('#right').append(nav, head, h('div', { class: 'tab-panels' }, this.panels.director, this.panels.spec, this.panels.wgsl));
        this.selectTab('director');
        this.director.onChange = name => this.syncSpecFromRuntime(name);
        this.director.onResetSim = () => this.runtime?.reset();
    }

    private mountEmpty(): void {
        const chips = STARTERS.map(s => {
            const b = h('button', { type: 'button', class: 'chip chip-lg' }, s.label);
            b.addEventListener('click', () => this.starter(s.prompt));
            return b;
        });
        // Where the idea and the steps are depends on the layout: beside the stage, or below it once the panels stack.
        this.empty.replaceChildren(h('div', { class: 'empty-card' },
            h('span', { class: 'empty-logo', html: logo(64) }),
            // A saved world being opened says where it stands first, then the card offers a new idea as ever (W3.6).
            this.openBlock,
            h('h3', null, 'Describe a world'),
            h('p', { class: 'empty-building', role: 'status', html: 'Follow the steps <span class="at-wide">on the left</span><span class="at-narrow">below</span>' }),
            h('p', { class: 'empty-lede', html: '<span class="at-wide">Type an idea on the left, or tap one below.</span><span class="at-narrow">Tap an idea below, or scroll down to type your own.</span> It turns into a living 3D world you can fly around, and then into a video.' }),
            h('div', { class: 'empty-examples' }, chips),
        ), h('p', { class: 'empty-source' }));
    }

    /** Camera-app controls on the viewport itself: the shape, a photo and the record button. */
    private mountCaptureBar(): void {
        const shapes = h('div', { class: 'segmented capture-shapes', role: 'radiogroup', 'aria-label': 'Photo and video shape' },
            FORMATS.map(f => {
                const b = h('button', { type: 'button', role: 'radio', title: `${f.label} ${f.ratio} · ${f.where}`, 'aria-checked': String(f.id === this.format), html: `${icon(f.icon, 14)}<span>${f.label}</span>` });
                b.dataset.format = f.id;
                b.addEventListener('click', () => this.setFormat(f.id, true));
                return b;
            }));
        const photo = h('button', { type: 'button', class: 'cap-btn', title: 'Save a photo (P)', html: `${icon('camera', 17)}<span>Photo</span>` });
        photo.addEventListener('click', () => void this.takeSnapshot());
        this.recordBtn.addEventListener('click', () => this.openExport());
        this.captureBar.replaceChildren(shapes, photo, this.recordBtn);
    }

    private setFormat(id: FormatId, showGuide: boolean): void {
        this.format = id;
        for (const b of this.captureBar.querySelectorAll<HTMLElement>('[data-format]')) b.setAttribute('aria-checked', String(b.dataset.format === id));
        // Picking a shape shows what it will include; the guide stays until switched off.
        if (showGuide) this.setGuide(true);
        else this.layoutFilmGate();
    }

    private setGuide(on: boolean): void {
        this.guideOn = on;
        this.gate.hidden = !on;
        this.timeline.setFilmGate(on);
        if (this.viewport) this.viewport.frameAspect = on ? formatById(this.format).aspect : null;
        this.layoutFilmGate();
    }

    /**
     * During a run, Developer view follows the work onto the Spec and WGSL tabs only when a code tab is already
     * open: a developer on Controls keeps Controls (the user, 10-28: the code is not what one opens the run to see).
     */
    private followTab(tab: Tab): void {
        if (!this.devView || this.tabs.director.getAttribute('aria-selected') === 'true') return;
        this.selectTab(tab);
    }

    /** After a run that brought no world: the running world's controls again, or the empty panel. */
    /**
     * The Controls panel as H's kind says (§8 step 5), after an h1 build that brought no world: h1's world's sliders, an
     * agent world's note that it has none (EA9.3's review: the empty stage's text was shown for it), or nothing.
     */
    private restoreControls(): void {
        if (this.runtime && this.viewport) this.director.bind(this.runtime, this.viewport);
        else if (this.agentWorld) this.director.note(this.agentControlsNote());
        else this.director.clear();
    }

    /** What the Controls panel says of an agent world, which has no sliders yet (Q85): plain words, or Developer view's. */
    private agentControlsNote(): string {
        return this.devView ? 'This world was built from an agent program: its controls are not here yet.' : COPY.creation.noControls;
    }

    private selectTab(tab: Tab): void {
        // The spec and WGSL tabs follow the run only where they can be seen.
        if (!this.devView && tab !== 'director') return;
        for (const [t, b] of Object.entries(this.tabs) as Array<[Tab, HTMLButtonElement]>) {
            b.setAttribute('aria-selected', String(t === tab));
            this.panels[t].hidden = t !== tab;
        }
    }

    // ------------------------------------------------------------------ generation

    /** One run of the loop over `source`, drawn as it happens; the world swapped in only once it has passed. */
    private async forge(source: Source): Promise<void> {
        const vp = this.viewport;
        if (!vp || !this.ladder || this.busy) return;
        // ?agent=1: never beside a Run, whose probe times the device and whose ledger would leave this build out; a Run
        // waits for an example's build the same way (stageHolders' `building`; EA9.3's review).
        if (this.stage?.busy) return;
        const prompt = this.prompt.value.trim();
        if (!prompt) { this.prompt.focus(); return; }
        const client = source === 'mock' || !this.live ? this.mock : this.live;
        // On the agent path no Create reaches h1's routes (I4): only its hand-written examples, over the mock.
        if (this.path.create === 'agent' && client !== this.mock) return;
        // A live world's calls are one identity's: while Sign in, Sign out or a collision's sign-in is under way, Create
        // (the button or its shortcut) waits (the W1 review, 2026-11-02).
        if (client === this.live && this.accountControl?.changing) return;
        this.abort?.abort();
        const ac = new AbortController();
        this.abort = ac;
        const req = { prompt, style: this.style.value as Style | 'auto', seconds: Number(this.length.value) };
        this.setBusy(true);
        this.trace.reset();
        this.journey.reset();
        this.calls = [];
        this.trace.setCalls([]);
        this.editedTargets.clear();
        this.showSourceBadge(client.source);

        const steps = new Map<string, TraceStep>();
        /** Each function's text before its repair, for the count of changed lines (FE1.5). */
        const bases = new Map<string, string>();
        let stage: StageId = 'plan';
        let candidate: SceneSpec | null = null;
        const onEvent = (e: LoopEvent) => {
            switch (e.type) {
                case 'planning':
                    steps.set('plan', this.trace.add('Plan the world', 'spark'));
                    steps.get('plan')!.setDetail(COPY.reading);
                    this.journey.start('plan', COPY.reading);
                    this.followTab('spec');
                    this.specView.setText('', true);
                    break;
                case 'plan-text':
                    this.specView.setText(e.soFar, true);
                    steps.get('plan')?.setDetail(`Streaming the plan · ${fmtInt(e.soFar.length)} characters`);
                    break;
                case 'planned': {
                    this.account(e.generation);
                    const named = e.draft.uniforms.filter(u => u.name !== QUALITY_UNIFORM);
                    const controls = named.length;
                    // The controls take shape as soon as the plan names them: shown now, asleep until the world runs.
                    if (!e.ready) this.director.preview(named.map(u => ({ label: u.label, min: u.min, max: u.max, step: u.step ?? 0.01, value: u.value })));
                    steps.get('plan')?.ok(`${e.draft.title}: ${e.draft.summary}${e.clamped.length ? ` · clamped: ${e.clamped.join('; ')}` : ''}`, callMeta(e.generation));
                    $('#scene-title').textContent = e.draft.title;
                    this.journey.done('plan', `${e.draft.title.split(':')[0]} · ${controls} things you can change`);
                    stage = 'build';
                    if (e.ready) this.journey.done('build', 'Motion, light and scenery');
                    else this.journey.start('build', COPY.working);
                    break;
                }
                case 'authoring':
                    this.followTab('wgsl');
                    this.texts = {};
                    this.marks = {};
                    this.wgslView.setEditable(false);
                    for (const fn of e.fns) {
                        const s = this.trace.add(`Write ${fn}`, 'code');
                        s.setDetail(COPY.writing[fn]);
                        steps.set(fn, s);
                    }
                    break;
                case 'function-text':
                    this.texts[e.fn] = e.soFar;
                    this.activeTarget = e.fn;
                    this.showTarget(e.fn, true);
                    steps.get(e.fn)?.setDetail(`Writing ${e.fn} · ${lineCount(e.soFar)} lines`);
                    this.journey.detail(stage, stage === 'build' ? COPY.writing[e.fn] : COPY.repairing);
                    break;
                case 'authored':
                    this.account(e.generation);
                    this.texts[e.fn] = e.text;
                    steps.get(e.fn)?.ok(`${lineCount(e.text)} lines of WGSL against host h1`, callMeta(e.generation));
                    break;
                case 'verifying': {
                    candidate = e.spec;
                    if (e.attempt === 1) {
                        this.journey.done('build', e.spec.sky === 'function' ? 'Motion, light and sky' : 'Motion and light');
                        this.journey.start('check', COPY.checking);
                        stage = 'check';
                    } else {
                        this.journey.detail('check', COPY.checking);
                    }
                    this.draftSpec = e.spec;
                    this.draftIsLive = false;
                    this.syncTexts(e.spec);
                    const s = this.trace.add(e.attempt === 1 ? 'Verify on this graphics card' : `Verify again · attempt ${e.attempt}`, 'gate');
                    s.setDetail('Lint, auto-fix, compile, probe, sanity, then the full build…');
                    steps.set(`verify${e.attempt}`, s);
                    if (e.attempt === 1) this.showMessage(COPY.warming, 'busy');
                    break;
                }
                case 'verified': {
                    this.showMessage(null);
                    const s = steps.get(`verify${e.attempt}`);
                    const rungs = e.result.report.rungs.map(r => `${r.rung} ${RUNG_NAMES[r.rung]} ${r.ok ? '✓' : '✗'} ${fmtMs(r.ms)}`).join(' · ');
                    if (e.result.ok) {
                        s?.ok(rungs, fmtMs(e.result.report.totalMs));
                        this.showDiagnostics([]);
                    } else {
                        const f = e.result.failure;
                        s?.error(`${f.rung}: ${f.message}`, fmtMs(e.result.report.totalMs));
                        if (f.diagnostics[0]) s?.attach(diagnosticBlock(f.diagnostics[0]));
                        this.showFailure(f);
                    }
                    if (e.result.report.probe) {
                        const p = e.result.report.probe;
                        const draw = p.frameMs === null ? 'draw not timed' : `draw ${p.frameMs.toFixed(1)}`;
                        const measured = p.measuredFrameMs === null ? `${p.measuredStepMs.toFixed(2)} ms a step` : `${p.measuredStepMs.toFixed(2)} and ${p.measuredFrameMs.toFixed(2)} ms`;
                        s?.attach(h('div', { class: 'snippet' }, h('div', { class: 'snippet-msg' }, `Probe: ${Math.round(p.predictedMs)} ms a frame predicted (step ${p.stepMs.toFixed(1)}, ${draw}); measured ${measured} in the small probe; budget ${p.budgetMs} ms`)));
                    }
                    break;
                }
                case 'repairing': {
                    // The text the repair starts from, kept here: the stream's function-text events overwrite
                    // texts[fn] as the repair arrives, so at 'repaired' the old text would already be gone.
                    bases.set(e.fn, this.texts[e.fn] ?? '');
                    this.journey.detail('check', COPY.repairing);
                    const s = this.trace.add(`Repair ${e.fn} · attempt ${e.attempt}`, 'code');
                    s.setDetail(`Sending ${e.failure.diagnostics.length} finding${e.failure.diagnostics.length === 1 ? '' : 's'} from ${e.failure.rung}…`);
                    s.attach(h('pre', { class: 'payload' }, formatJson(e.failure.diagnostics.map(d => ({ source: d.source, line: d.line, column: d.column, message: d.message, snippet: d.snippet })))));
                    steps.set(e.fn, s);
                    break;
                }
                case 'repaired': {
                    this.account(e.generation);
                    const before = bases.get(e.fn) ?? '';
                    this.texts[e.fn] = e.text;
                    this.marks[e.fn] = changedLines(before, e.text).map(line => ({ line, kind: 'patched' as const, message: 'changed by the repair' }));
                    this.showTarget(e.fn);
                    steps.get(e.fn)?.ok(`${e.fn} rewritten: ${this.marks[e.fn]!.length} line${this.marks[e.fn]!.length === 1 ? '' : 's'} changed`, callMeta(e.generation));
                    break;
                }
                case 'retrying': {
                    // The failed try closes with its reason, and the retry gets a row of its own: no clock runs on
                    // after a failure (the user, 10-28: "planner never get closed once downstream fails").
                    const key = e.what;
                    steps.get(key)?.warn(`${e.error.code}: ${e.error.message} Trying once more…`);
                    const again = key === 'plan' ? this.trace.add('Plan the world · try 2', 'spark') : this.trace.add(`Write ${key} · try 2`, 'code');
                    again.setDetail(key === 'plan' ? COPY.reading : COPY.writing[key]);
                    steps.set(key, again);
                    break;
                }
                case 'slow': {
                    const text = e.what === 'plan' ? COPY.slow.plan : e.what === 'repair' ? COPY.slow.repair : COPY.slow[e.what];
                    this.journey.detail(stage, text);
                    if (e.what !== 'repair') steps.get(e.what)?.setDetail(text);
                    break;
                }
            }
        };

        try {
            const outcome: LoopOutcome<SceneRuntime> = await runLoop({ client, verifier: this.ladder }, req, onEvent, ac.signal);
            if (!outcome.ok) {
                // Whatever was still running stops with the run, with the reason on its own row.
                for (const s of steps.values()) {
                    if (!s.running) continue;
                    if (outcome.kind === 'cancelled') s.warn('Cancelled');
                    else s.error(outcome.detail);
                }
                if (outcome.kind === 'cancelled') return;
                this.trace.add('Stopped', stage === 'plan' ? 'spark' : stage === 'build' ? 'code' : 'gate').error(`${outcome.sentence} (${outcome.detail})`);
                this.journey.fail(stage, outcome.sentence);
                // W1: the free world spent, or today's made: the limit dialog, the idea in its box and the world on stage kept.
                if (outcome.kind === 'allowance' || outcome.kind === 'quota') this.accountControl?.limit(outcome.kind, outcome.sentence);
                this.restoreControls();
                // A world the ladder refused is evidence too (F6): reported now, with no fps.
                if (outcome.outcome) this.send(client, completeOutcome(outcome.outcome, { fps: null, ...this.gpuLabels() }));
                if (candidate) {
                    // The draft stays in the editor for a manual fix (Developer view).
                    this.draftSpec = candidate;
                    this.wgslView.setEditable(true);
                }
                return;
            }
            const { world, spec, stats } = outcome;
            if (!this.install(world, spec, false, client.source)) {
                // Not switched: the world on the stage stays, and the one built is gone (its teardown said in the trace).
                this.journey.fail('check', COPY.failures.internal);
                this.restoreControls();
                return;
            }
            this.builds++;
            console.info(`Wexy: build ${this.builds} "${spec.title}" live (${client.source}), ${world.count} particles, plan ${Math.round(stats.planMs)} ms, author ${Math.round(stats.authorMs)} ms, ${stats.repairs} repair(s), ${stats.autofixes} auto-fix(es)`);
            this.journey.done('check', COPY.runs);
            this.journey.done('ready', COPY.ready);
            this.nudgeRecord();
            this.report(client, world, outcome.outcome);
        } catch (e) {
            if ((e as Error).name === 'AbortError') return;
            for (const s of steps.values()) if (s.running) s.error((e as Error).message);
            this.trace.add('Pipeline stopped', 'gpu').error((e as Error).message);
            this.journey.fail(stage, COPY.failures.internal);
            this.restoreControls();
        } finally {
            if (this.abort === ac) this.abort = null;
            // A run that brought no world lets the backdrop play again.
            this.releaseBackdrop();
            this.setBusy(false);
            // The call made or found an identity: who it is, and what the server says is left (W1).
            if (client === this.live) void this.accountControl?.afterEntry();
        }
    }

    /** The outcome report, once the preview has settled; the backend turns these into Wexy's numbers. */
    private report(client: ForgeClient, world: SceneRuntime, outcome: OutcomeReport): void {
        const vp = this.viewport!;
        const live = this.trace.add('Live preview', 'live');
        live.setDetail('Letting the frame-time guard settle…');
        window.setTimeout(() => {
            if (this.runtime !== world) { live.warn('Replaced before it settled'); return; }
            const s = vp.frameStats;
            live.ok(`${Math.round(s.fps)} fps at ${s.width}×${s.height}${world.qualityFloor !== null ? ` · quality ${s.quality.toFixed(2)}` : ''} · director ready`, 'export always renders at full quality');
            this.send(client, completeOutcome(outcome, { fps: s.fps, ...this.gpuLabels() }));
        }, 4000);
    }

    /** This graphics card and browser, as an outcome names them. */
    private gpuLabels(): { adapter: string | null; browser: string | null } {
        const vp = this.viewport!;
        const brand = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData?.brands?.find(b => !/Not.A.Brand/i.test(b.brand));
        return {
            adapter: `${vp.gpu.vendor} ${vp.gpu.architecture}`.trim() || null,
            browser: brand ? `${brand.brand} ${brand.version}` : navigator.userAgent.slice(0, 64),
        };
    }

    /** An outcome to the backend, with its own row in the trace; a playground example is heard by no backend. */
    private send(client: ForgeClient, complete: OutcomeReport): void {
        if (client.source === 'mock') return;
        const step = this.trace.add('Report the outcome', 'spark');
        step.setDetail(`${complete.generationIds.length} generations · first pass ${complete.firstPassOk ? 'ok' : 'failed'} · ${complete.repairs} repairs · ${complete.fps ?? 'no'} fps`);
        client.report(complete).then(() => step.ok('Recorded by the backend (202)'), e => step.warn(`Not recorded: ${(e as Error).message}`));
    }

    /** The failing rung's diagnostics in the editor, on the lines they name. */
    private showFailure(f: VerifyFailure): void {
        this.marks = {};
        for (const d of f.diagnostics) (this.marks[d.target] ??= []).push({ line: d.line, kind: 'error', message: d.message });
        if (f.diagnostics[0]) {
            this.activeTarget = f.diagnostics[0].target;
            this.selectTab('wgsl');
        }
        this.showTarget(this.activeTarget);
        if (f.diagnostics[0]?.line) this.wgslView.revealLine(f.diagnostics[0].line);
        this.showDiagnostics(f.diagnostics);
    }

    private showDiagnostics(diagnostics: GateDiagnostic[]): void {
        this.diagList.replaceChildren(...diagnostics.map(d => {
            const li = h('li', { class: `diag diag-${d.source}` },
                h('span', { class: 'diag-loc' }, `${d.target}.wgsl:${d.line}:${d.column}`),
                h('span', { class: 'diag-msg' }, d.message),
                h('span', { class: 'diag-src' }, { tint: 'compiler', contract: 'host contract', probe: 'cost probe', sanity: 'sanity look' }[d.source]));
            li.addEventListener('click', () => { this.showTarget(d.target); if (d.line) this.wgslView.revealLine(d.line); });
            return li;
        }));
    }

    /**
     * h1's world onto the stage (§8 step 1), through `put`: the switch (the viewport's setRuntime), this world's page, then
     * the old world's retirement, whatever its kind, after the swap (L8): it kept rendering while this one was checked and
     * built, and the backdrop, held still through the check, goes the same way.
     */
    private install(runtime: SceneRuntime, spec: SceneSpec, keepCamera: boolean, source: Source): boolean {
        const vp = this.viewport!;
        const old = this.runtime;
        const previousParams = old && keepCamera ? old.uniformNames.map(n => [n, old.getParam(n)] as const) : [];
        for (const [name, v] of previousParams) runtime.setParam(name, v);
        const leaving = this.agentWorld !== null;
        // The new Head, counted in the stage's ledger (I7) beside the old world until that one's retirement (§8 step 2), at
        // the largest canvas the viewport ever gives a world (count).
        const held = this.stage?.ledger.record(`head: ${spec.title}`, runtime.deviceBytesAt(MAX_LIVE_PIXELS)) ?? null;
        this.put({ kind: 'legacy', legacy: { runtime, spec, source }, held }, () => vp.setRuntime(runtime), () => this.publishLegacy(runtime, spec, keepCamera, source));
        // A switch that did not happen (the viewport refused it) leaves the old world, and this one is gone: the caller
        // says so, never that it is ready (EA9.3's review).
        if (this.runtime !== runtime) return false;
        if (leaving) {
            // The agent world's reviews stay as history; none can authorize anything now (EA6).
            this.afterSwitch('the old world\'s reviews', () => this.reviews?.installed(null));
            // Its creation's session goes with it (I8): no paid action on a world no longer on the stage.
            this.afterSwitch('the old world\'s creation', () => this.creation?.replaced());
        }
        return true;
    }

    /** h1's world's page (§8 steps 3 to 7): its draft in the editor, its path and keyframes, the Director, its title and source. */
    private publishLegacy(runtime: SceneRuntime, spec: SceneSpec, keepCamera: boolean, source: Source): void {
        const vp = this.viewport!;
        this.draftSource = source;
        this.draftSpec = structuredClone(spec);
        this.draftIsLive = true;
        this.editedTargets.clear();
        if (!keepCamera) {
            vp.setView(firstView(spec.camera.keyframes));
            vp.playhead = 0;
            this.setMode('path', true);
            this.setPlaying(true);
        }
        this.rebuildPath();
        this.timeline.setKeyframes(spec.camera.keyframes);
        this.director.bind(runtime, vp);
        this.renderSpec();
        this.syncTexts(spec);
        this.wgslView.setEditable(true);
        this.swapBtn.disabled = true;
        this.revertBtn.disabled = true;
        this.empty.hidden = true;
        this.hud.root.hidden = false;
        this.hud.title.textContent = spec.title;
        this.hud.source.textContent = COPY.source[source];
        this.hud.source.title = COPY.sourceTitle[source];
        this.hud.source.hidden = false;
        this.showSourceBadge(source);
        this.hud.count.textContent = `${fmtInt(runtime.count)} particles`;
        this.captureBar.hidden = false;
        this.exportBtn.disabled = false;
        this.snapBtn.disabled = false;
        if (!keepCamera) this.selectTab('director');
    }

    /**
     * Check the edited text through the same ladder and swap the world in. Edits to the running world keep the
     * camera and slider values; a fixed draft that never ran starts fresh. No model is called.
     */
    private async hotSwap(): Promise<void> {
        const draft = this.draftSpec;
        if (!draft || this.busy || !this.viewport || !this.ladder) return;
        // Never beside a Run, as forge (EA9.3's review).
        if (this.stage?.busy) return;
        const sameScene = this.draftIsLive && !!this.spec && this.runtime !== null;
        // Start from the running spec when it is the same world: it carries the director's edits.
        let spec: SceneSpec = structuredClone(sameScene ? this.spec! : draft);
        for (const target of targetsOf(spec)) {
            const text = this.texts[target];
            if (text !== undefined) spec = withProgramText(spec, target, text);
        }
        this.setBusy(true);
        const ac = new AbortController();
        this.abort = ac;
        try {
            const step = this.trace.add('Hot-swap: the ladder', 'gate');
            const result = await this.ladder.verify(spec, ac.signal);
            const rungs = result.report.rungs.map(r => `${r.rung} ${RUNG_NAMES[r.rung]} ${r.ok ? '✓' : '✗'} ${fmtMs(r.ms)}`).join(' · ');
            if (!result.ok) {
                step.error(`${result.failure.rung}: ${result.failure.message}. The running world is untouched.`, fmtMs(result.report.totalMs));
                this.showFailure(result.failure);
                return;
            }
            step.ok(rungs, 'edited by hand');
            this.showDiagnostics([]);
            if (!this.install(result.world, result.spec, sameScene, this.draftSource)) this.showMessage(COPY.editFailed, 'error');
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                this.trace.add('Hot-swap stopped', 'gate').error(String(error));
                this.showMessage(COPY.editFailed, 'error');
            }
        } finally {
            if (this.abort === ac) this.abort = null;
            this.releaseBackdrop();
            this.setBusy(false);
        }
    }

    /** Back to the text as last loaded: the running world's, or the draft's as the model wrote it. */
    private revert(): void {
        if (!this.draftSpec) return;
        this.syncTexts(this.draftSpec);
        this.editedTargets.clear();
        this.marks = {};
        this.showTarget(this.activeTarget);
        this.diagList.replaceChildren();
        this.swapBtn.disabled = true;
        this.revertBtn.disabled = true;
    }

    /** Count a model call. A mock call made no request. */
    private account(g: GenerationInfo): void {
        if (g.source === 'mock') return;
        this.calls.push(g);
        this.trace.setCalls(this.calls);
    }

    private setBusy(busy: boolean): void {
        this.busy = busy;
        this.accountControl?.setBusy(busy || !!this.creation?.busy);
        if (this.path.create === 'agent') {
            // The agent path's button is the creation view's: an example being built only blocks its Create.
            this.renderCreate();
        } else {
            this.forgeBtn.disabled = busy || !this.viewport || !!this.accountControl?.changing;
            this.forgeBtn.classList.toggle('is-busy', busy);
            this.forgeBtn.querySelector('span')!.textContent = busy ? 'Creating…' : 'Create world';
        }
        this.setBuilding(busy || !!this.creation?.busy);
        this.swapBtn.disabled = busy || !this.draftSpec || (this.editedTargets.size === 0 && this.draftIsLive);
    }

    /** While the empty stage waits for a first world, its mark turns and the starters step aside. */
    private setBuilding(busy: boolean): void {
        if (this.empty.classList.contains('is-building') === busy) return;
        this.empty.classList.toggle('is-building', busy);
        const title = this.empty.querySelector('h3');
        if (title) title.textContent = busy ? 'Making your world' : 'Describe a world';
        this.renderMark();
    }

    /**
     * The empty stage's mark, at rest or turning. With a backdrop it turns as the small spinner does, with nothing to
     * load; without one, the loader video plays (public/loader1.mp4).
     */
    private renderMark(): void {
        const mark = this.empty.querySelector<HTMLElement>('.empty-logo:not(.warn)');
        if (!mark) return;
        const state = !this.empty.classList.contains('is-building') ? 'rest' : this.backdrop ? 'turning' : 'video';
        if (mark.dataset.state === state) return;
        mark.dataset.state = state;
        mark.innerHTML = state === 'turning' ? '<i class="spinner"></i>' : state === 'video' ? loader(1, 132) : logo(64);
    }

    // ------------------------------------------------------------------ the empty stage's backdrop

    /**
     * A playground example drawn live behind the empty card (backdrop.ts); the still stage stays if it cannot be built. It
     * is H from now (EA9.3, §8): counted in the stage's ledger once it is on the viewport, so a candidate is admitted beside
     * it, never past it; the first world's install retires it.
     */
    private mountBackdrop(vp: Viewport, id: string): void {
        if (this.world.kind !== 'empty') return;
        const backdrop = startBackdrop(vp, id, { touch: TOUCH, still: matchMedia('(prefers-reduced-motion: reduce)').matches });
        if (!backdrop) return;
        // No switch here: it reaches the viewport by itself once built, and only while no world has.
        this.put({ kind: 'backdrop', backdrop, held: null }, null, () => {});
        void backdrop.ready.then(live => {
            if (this.backdrop !== backdrop) return;
            if (!live) {
                // Never on the viewport: the stage is empty again, and a Run may be admitted.
                this.put(EMPTY, null, () => this.renderMark());
                this.refreshRun();
                return;
            }
            // On the viewport: counted from now (§8 step 2), so a Run waits no more.
            this.count();
            this.refreshRun();
            // Its source, as the HUD names a world's (design guidelines §3).
            const label = STARTERS.find(s => s.id === id)?.label ?? id;
            const source = this.empty.querySelector('.empty-source');
            if (source) source.textContent = `${label} · playground example, running live`;
            this.empty.classList.add('has-backdrop');
        });
    }

    private holdBackdrop(): void {
        if (this.backdrop && !this.backdropHold) this.backdropHold = this.backdrop.hold();
    }

    private releaseBackdrop(): void {
        this.backdropHold?.();
        this.backdropHold = null;
    }

    // ------------------------------------------------------------------ WGSL + spec views

    private syncTexts(spec: SceneSpec): void {
        this.texts = {};
        for (const target of targetsOf(spec)) {
            const text = programText(spec, target);
            if (text !== undefined) this.texts[target] = text;
        }
        if (this.texts[this.activeTarget] === undefined) this.activeTarget = 'evolve';
        this.showTarget(this.activeTarget);
    }

    private showTarget(target: ProgramTarget, follow = false): void {
        this.activeTarget = target;
        this.wgslView.setText(this.texts[target] ?? '', follow);
        this.wgslView.setMarks(this.marks[target] ?? []);
        const spec = this.draftSpec ?? this.spec;
        const uniforms = spec?.uniforms ?? {};
        const module = spec?.program.kind === 'hooks' || target === 'particles' || target === 'backdrop'
            ? hookHeader(target as 'evolve' | 'particles' | 'backdrop', uniforms)
            : assembleModule(target as 'evolve' | 'look' | 'sky', `    // … your fn ${target} …`, uniforms).code;
        this.headerBox.innerHTML = module.trimEnd().split('\n').map(highlightWgslLine).join('\n');
        this.renderTargetTabs();
    }

    private renderTargetTabs(): void {
        const spec = this.draftSpec ?? this.spec;
        const targets: ProgramTarget[] = spec ? targetsOf(spec) : ['evolve', 'look', 'sky'];
        this.hookTabs.replaceChildren(...targets.map(k => {
            const marks = this.marks[k] ?? [];
            const state = marks.some(m => m.kind === 'error') ? 'error' : marks.some(m => m.kind === 'patched') ? 'patched' : this.editedTargets.has(k) ? 'edited' : '';
            const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === this.activeTarget), class: state ? `has-${state}` : '', title: `${k}.wgsl` },
                h('i', { class: 'dot' }), k, h('small', null, String(lineCount(this.texts[k] ?? ''))));
            b.addEventListener('click', () => this.showTarget(k));
            return b;
        }));
    }

    private renderSpec(): void {
        if (!this.spec) return;
        const program: Record<string, string> = { kind: this.spec.program.kind };
        for (const target of targetsOf(this.spec)) program[target] = `‹${lineCount(programText(this.spec, target) ?? '')} lines of WGSL · WGSL tab›`;
        this.specView.setText(formatJson({ ...this.spec, program }));
    }

    /** Director moves are part of the film: write them back so the spec reproduces the export. */
    private syncSpecFromRuntime(uniform?: string): void {
        const rt = this.runtime, spec = this.spec;
        if (!rt || !spec) return;
        if (uniform && spec.uniforms[uniform]) spec.uniforms[uniform].value = Math.round(rt.getParam(uniform) * 1000) / 1000;
        const p = spec.post, post = rt.post;
        if (p.tonemap) p.tonemap.exposure = round3(post.tonemap.exposure);
        if (p.bloom && post.bloom) { p.bloom.intensity = round3(post.bloom.intensity); p.bloom.threshold = round3(post.bloom.threshold); }
        if (p.halation && post.halation) p.halation.intensity = round3(post.halation.intensity);
        if (p.outline && post.outline) p.outline.strength = round3(post.outline.strength);
        if (p.vignette && post.vignette) p.vignette.intensity = round3(post.vignette.intensity);
        clearTimeout(this.specTimer);
        this.specTimer = window.setTimeout(() => this.renderSpec(), 250);
    }

    // ------------------------------------------------------------------ camera + timeline

    private wireTimeline(): void {
        const tl = this.timeline;
        tl.onSeek = s => this.seek(s);
        tl.onTogglePlay = () => this.setPlaying(!tl.isPlaying);
        tl.onMode = m => this.setMode(m, true);
        tl.onAddKey = () => this.addKeyframe();
        tl.onRemoveKey = i => this.removeKeyframe(i);
        tl.onSelectKey = i => this.selectKeyframe(i);
        tl.onFilmGate = on => this.setGuide(on);
        tl.setDuration(this.duration);
        tl.setPlayhead(0);
    }

    private wireKeys(): void {
        window.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !this.exporter.el.open) {
                e.preventDefault();
                // A held shortcut repeats: each repeat would press again, through Show it into a new paid Create (the EA9.2
                // review). Only the first press of the keys counts, on either path.
                if (e.repeat) return;
                if (this.path.create === 'agent') this.creationView?.shortcut();
                else void this.forge(this.live ? 'live' : 'mock');
                return;
            }
            if (isTyping() || e.ctrlKey || e.metaKey || e.altKey || this.exporter.el.open) return;
            if (e.key === ' ' && this.runtime) { e.preventDefault(); this.setPlaying(!this.timeline.isPlaying); }
            else if (e.key.toLowerCase() === 'k' && this.runtime) this.addKeyframe();
            else if (e.key.toLowerCase() === 'p' && (this.runtime || this.agentWorld)) void this.takeSnapshot();
            else if (e.key.toLowerCase() === 'r' && (this.runtime || this.agentWorld)) this.openExport();
            else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedKey >= 0) this.removeKeyframe(this.selectedKey);
        });
    }

    private setDuration(seconds: number): void {
        this.duration = seconds;
        if (this.viewport) {
            this.viewport.duration = seconds;
            this.viewport.playhead = Math.min(this.viewport.playhead, seconds);
        }
        this.timeline.setDuration(seconds);
        this.rebuildPath();
    }

    private rebuildPath(): void {
        if (!this.viewport || !this.spec) return;
        this.viewport.path = cameraPath(this.spec.camera.keyframes, this.duration);
        this.viewport.duration = this.duration;
    }

    private seek(seconds: number): void {
        if (!this.viewport) return;
        this.viewport.playhead = Math.min(this.duration, Math.max(0, seconds));
        this.timeline.setPlayhead(this.viewport.playhead);
    }

    private setPlaying(playing: boolean): void {
        if (!this.viewport) return;
        if (playing && this.viewport.mode !== 'path') this.setMode('path', true);
        this.viewport.playing = playing;
        this.timeline.setPlaying(playing);
    }

    private setMode(mode: CameraMode, apply: boolean): void {
        const vp = this.viewport;
        if (vp && apply && vp.mode !== mode) {
            if (mode === 'orbit') vp.setView(vp.currentView());
            vp.mode = mode;
        }
        if (vp && mode === 'orbit') {
            vp.playing = false;
            this.timeline.setPlaying(false);
        }
        this.timeline.setMode(mode);
        this.hud.cam.innerHTML = mode === 'path'
            ? `${icon('route', 12)}<span>Playing the camera move · drag to look around</span>`
            : `${icon('orbit', 12)}<span>${TOUCH ? 'Drag to look around · pinch to zoom' : 'Drag to look around · scroll to zoom · K saves the view'}</span>`;
    }

    private addKeyframe(): void {
        const vp = this.viewport, spec = this.spec;
        if (!vp || !spec) return;
        const t = vp.playhead / this.duration;
        const key = viewToKeyframe(vp.currentView(), t);
        // A key within ~2% of the playhead is replaced rather than stacked.
        const keys = spec.camera.keyframes.filter(k => Math.abs(k.t - key.t) > 0.02);
        keys.push(key);
        keys.sort((a, b) => a.t - b.t);
        spec.camera.keyframes = keys;
        this.afterKeysChanged(keys.indexOf(key));
    }

    private removeKeyframe(index: number): void {
        const spec = this.spec;
        if (!spec || spec.camera.keyframes.length <= 1) return;
        spec.camera.keyframes.splice(index, 1);
        this.afterKeysChanged(-1);
    }

    private selectKeyframe(index: number): void {
        const vp = this.viewport, key = this.spec?.camera.keyframes[index];
        if (!vp || !key) return;
        this.selectedKey = index;
        this.timeline.select(index);
        this.seek(key.t * this.duration);
        if (vp.mode === 'orbit') vp.setView(keyframeToView(key));
    }

    private afterKeysChanged(selected: number): void {
        this.rebuildPath();
        this.selectedKey = selected;
        this.timeline.setKeyframes(this.spec!.camera.keyframes);
        this.timeline.select(selected);
        this.renderSpec();
    }

    /** Matches Viewport.frameAspect's containView: the guide is exactly the exported frame. */
    private layoutFilmGate(): void {
        const f = formatById(this.format);
        this.gateLabel.textContent = `${f.label} ${f.ratio}`;
        if (this.viewport && this.guideOn) this.viewport.frameAspect = f.aspect;
        if (this.gate.hidden) return;
        const r = $('#viewport').getBoundingClientRect();
        const w = Math.min(r.width, r.height * f.aspect);
        this.gateFrame.style.width = `${w}px`;
        this.gateFrame.style.height = `${w / f.aspect}px`;
    }

    // ------------------------------------------------------------------ frame, export, messages

    private onFrame(fps: number, width: number, height: number, quality: number, scale: number): void {
        const vp = this.viewport!;
        // The world on the stage paused past what it was tested at (EA_RESIZE), or running again: Show it offers to test
        // it again at this size (the EA9.2 review: a pause had no way out for a creator).
        const paused = !!this.agentWorld?.runtime.isPaused;
        if (paused !== this.agentPaused) {
            this.agentPaused = paused;
            this.refreshRun();
        }
        this.timeline.setPlayhead(vp.playhead);
        const now = performance.now();
        if (now - this.lastHud < 250) return;
        this.lastHud = now;
        this.hud.fps.textContent = `${Math.round(fps)} fps`;
        this.hud.res.textContent = `${width}×${height}${this.runtime?.qualityFloor !== null && this.runtime ? ` · q ${quality.toFixed(2)}` : ''}`;
        // Reassure rather than report: when Auto trades detail for smoothness, say the video won't.
        this.hud.smooth.hidden = vp.pinnedRung !== null || (scale >= 1 && quality >= 1);
        this.director.refresh();
    }

    /** An agent world's film source (EA5.5): its candidate built again for each measurement, film and photo. */
    private agentFilmSource(world: AgentWorld): FilmSource | null {
        const make = this.agentFilm;
        if (!make) return null;
        return { workload: (fps, still) => make(world, fps, still), warmupSeconds: 0, provenance: { candidate: world.candidate, graph: world.snapshot.x.hash } };
    }

    private openExport(): void {
        const vp = this.viewport;
        if (!vp) return;
        // Not while a Run builds another world on the same device: its commit retires the world filmed here, whatever its
        // kind (P7; the EA9.1 review). Nor while an example is built: its install retires it too, and a film admitted now
        // would leave that build out of the ledger (EA9.3's review; a photo waited already).
        if (this.stage?.busy || this.busy) return;
        const world = this.agentWorld;
        if (world) {
            // An agent world's film (EA5.5): from its time zero, with the camera where it is now (W has no path).
            const film = this.agentFilmSource(world);
            if (!film) return;
            const still = vp.currentView();
            this.exporter.open({ viewport: vp, film, title: agentTitle(world), seconds: this.duration, format: this.format, pathFor: () => () => still });
            return;
        }
        const rt = this.runtime, spec = this.spec;
        if (!rt || !spec) return;
        this.setPlaying(false);
        this.exporter.open({
            viewport: vp,
            film: sceneFilm(spec, rt),
            title: spec.title,
            seconds: this.duration,
            format: this.format,
            pathFor: seconds => {
                const path = cameraPath(spec.camera.keyframes, seconds);
                const still = vp.currentView();
                return path ?? (() => still);
            },
        });
    }

    /** One click, one file: a Full HD photo in the chosen shape, saved straight away. */
    private async takeSnapshot(): Promise<void> {
        const vp = this.viewport, rt = this.runtime, spec = this.spec, world = this.agentWorld;
        if (!vp || this.busy || document.body.classList.contains('exporting')) return;
        // Never beside a Run, whose commit retires the world this photo draws, whatever its kind (P7; the EA9.1 review): an
        // h1 example stays on the stage while an agent world is tested to replace it.
        if (this.stage?.busy) return;
        // An agent world's photo (EA5.5) shows its time zero, its candidate built again for it; h1's, the live state.
        const film = world ? this.agentFilmSource(world) : null;
        if (world ? !film : !rt || !spec) return;
        const title = world ? agentTitle(world) : spec!.title;
        const { width, height } = frameSize(this.format, 'fhd');
        const view = vp.currentView();
        // A photo on an engine of its own; the preview waits, untouched (film.ts).
        const resume = vp.pause();
        let png: Blob;
        try {
            ({ png } = film ? await snapshotOf(vp.engine.device, film.workload(60, view), width, height, view) : await snapshotLive(vp.engine.device, rt!, width, height, view));
        } catch (e) {
            this.showMessage(`The photo could not be taken: ${(e as Error).message.replace(/^film: /, '')}`, 'error');
            return;
        } finally {
            resume();
        }
        const name = `${title.split(':')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${this.format}-${Date.now()}.png`;
        download(png, name);
        const file = new File([png], name, { type: 'image/png' });
        const f = formatById(this.format);
        this.showToast(`Photo saved · ${f.label} ${f.ratio}`, canShareFile(file) ? () => void shareFile(file, title) : null);
    }

    private showToast(text: string, onShare: (() => void) | null): void {
        clearTimeout(this.toastTimer);
        this.toast.replaceChildren(h('span', { html: icon('check', 14) }), h('span', null, text));
        if (onShare) this.toast.append(h('button', { type: 'button', class: 'btn btn-sm', html: `${icon('share', 13)}<span>Share</span>`, onclick: onShare }));
        this.toast.hidden = false;
        this.toastTimer = window.setTimeout(() => { this.toast.hidden = true; }, 4000);
    }

    /** After a new world appears, point once at the next step. */
    private nudgeRecord(): void {
        this.recordBtn.classList.remove('nudge');
        void this.recordBtn.offsetWidth;
        this.recordBtn.classList.add('nudge');
    }

    private showMessage(text: string | null, kind: 'busy' | 'error' = 'busy'): void {
        this.message.hidden = !text;
        if (!text) return;
        this.message.className = `viewport-msg msg-${kind}`;
        this.message.innerHTML = kind === 'busy' ? '<i class="spinner"></i><span></span>' : `${icon('alert', 16)}<span></span>`;
        (this.message.querySelector('span') as HTMLElement).textContent = text;
    }

    private showNoWebGPU(reason: string): void {
        $('#gpu-pill').innerHTML = '<i class="bad"></i><span>No WebGPU</span>';
        this.empty.replaceChildren(h('div', { class: 'empty-card' },
            h('span', { class: 'empty-logo warn', html: icon('alert', 28) }),
            h('h3', null, 'Your browser can\'t run live worlds yet'),
            h('p', null, `Wexy draws your world on your graphics card through WebGPU. Open it in Chrome or Edge (version 113 or newer) on a desktop, with hardware acceleration switched on. (${reason})`),
            h('a', { class: 'btn', href: './' }, 'Back to the home page'),
        ));
    }
}

/** An agent world's name in the studio: its creation's title (EA9.1), or, for a saved attempt replayed, its id(C), short. */
function agentTitle(world: { candidate: string; title: string | null }): string {
    return world.title ?? `Agent world ${world.candidate.slice(0, 12)}…`;
}

function round3(v: number): number {
    return Math.round(v * 1000) / 1000;
}

/** The lines of `after` that differ from `before`, 1-based. */
function changedLines(before: string, after: string): number[] {
    const a = before.split('\n'), b = after.split('\n');
    const lines: number[] = [];
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) lines.push(i + 1);
    return lines;
}

function diagnosticBlock(d: GateDiagnostic): HTMLElement {
    return h('div', { class: 'snippet snippet-error' },
        h('div', { class: 'snippet-msg' }, `${d.target}${d.line ? ` line ${d.line}` : ''}: ${d.message}`),
        d.snippet ? h('code', { html: `<span class="ln-no">${d.line}</span>${highlightWgslLine(d.snippet)}` }) : null);
}

void new Studio().init();
