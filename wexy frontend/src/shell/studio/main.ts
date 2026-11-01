// The Wexy studio: an idea -> the planner's draft -> the author's functions -> the verify ladder on this graphics
// card, with repair turns -> a live NullGraph world with controls, keyframes and MP4 export. The loop itself is
// src/loop (plain TypeScript); this file draws what it emits, swaps the world in once it has passed (L8), and
// reports the outcome. Worlds come from the backend's models (the live source) or from the playground's mock,
// and every world shows its source (design guidelines §3).
// Two views of one studio: the default speaks in plain words (Journey, Controls, the capture bar); Developer
// view, reached only by ?dev=1 (design guidelines §0), adds the technical log, the scene file, the WGSL editor
// and the GPU numbers.

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
import { cameraPath, firstView, keyframeToView, viewToKeyframe } from '../../runtime/camera-path';
import { snapshotLive, sweepFilms } from '../../capture/film';
import type { GateDiagnostic } from '../../verify/gate';
import { createLadder } from '../../verify/ladder';
import { RUNG_NAMES, runLoop, type LoopEvent, type LoopOutcome, type VerifyFailure, type Verifier } from '../../loop/machine';
import { COPY } from '../../loop/copy';
import { completeOutcome } from '../../loop/outcome';
import { SceneRuntime } from '../../runtime/scene-runtime';
import { Viewport, type CameraMode } from '../../runtime/viewport';
import type { ModuleCompiler } from '../../contract/adapters/bodies';
import { assembleModule } from '../../contract/host';
import { hookHeader } from '../../contract/wgsl';
import { $, download, h, isTyping } from '../../shared/dom';
import { fmtInt, fmtMs } from '../../shared/format';
import { highlightWgslLine } from '../../shared/highlight';
import { icon, loader, logo, wordmark } from '../../shared/icons';
import { formatJson } from '../../shared/json';
import { programText, QUALITY_UNIFORM, targetsOf, withProgramText, type ProgramTarget, type SceneSpec, type Style } from '../../contract/spec';
import { CodeView, type CodeMark } from './code-view';
import { DirectorPanel } from './director';
import { canShareFile, ExportDialog, shareFile } from './export-dialog';
import { formatById, FORMATS, frameSize, type FormatId } from './formats';
import { Journey, type StageId } from './journey';
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
    /** The running world's spec. Director moves are written back into it. */
    private spec: SceneSpec | null = null;
    private source: Source = 'mock';
    /**
     * The spec the editor's text belongs to, as last loaded. It differs from `spec` after a draft
     * fails the ladder: edits then belong to the new draft, not to the world still running.
     */
    private draftSpec: SceneSpec | null = null;
    /** True when the draft in the editor is the world that is running. */
    private draftIsLive = false;
    private runtime: SceneRuntime | null = null;
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

    async init(): Promise<void> {
        $('#brand-logo').innerHTML = wordmark(22);
        const params = new URLSearchParams(location.search);
        const config = readConfig();
        // One identity for every client: Firebase starts once per page.
        const api = config.apiOrigin ? createApi(config, createIdentity(config)) : null;
        if (api && params.get('source') !== 'mock') this.live = createLiveClient(api);
        const agent = params.get('agent') === '1';
        this.mountLeft();
        this.mountRight();
        $('#timeline-slot').replaceWith(this.timeline.el);
        this.mountEmpty();
        this.mountCaptureBar();
        this.wireTimeline();
        this.wireKeys();
        this.exportBtn.addEventListener('click', () => this.openExport());
        this.snapBtn.addEventListener('click', () => void this.takeSnapshot());
        this.setDevView((params.has('dev') && params.get('dev') !== '0') || agent);
        // Before the GPU starts: a turn needs none, and runs on a device without WebGPU too.
        if (agent) void this.mountAgent(api);
        this.exporter.onBusy = busy => {
            this.hud.mode.textContent = busy ? 'RECORDING' : 'LIVE';
            this.hud.root.classList.toggle('rendering', busy);
            document.body.classList.toggle('exporting', busy);
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
        this.ladder = createLadder(vp.engine, { width: () => vp.canvas.width, height: () => vp.canvas.height });
        $('#gpu-pill').replaceChildren(h('i', { class: 'ok' }), h('span', null, vp.gpuLabel));
        $('#gpu-pill').title = 'The adapter WebGPU gave this page. On hybrid-GPU laptops Chrome may pick the integrated GPU: set Chrome to "High performance" in Windows graphics settings.';
        vp.onFrame = stats => this.onFrame(stats.fps, stats.width, stats.height, stats.quality, stats.scale);
        vp.onOrbitTakeover = () => this.setMode('orbit', false);
        vp.onDeviceLost = msg => {
            this.deviceGeneration++;
            this.showMessage(`Your graphics card stopped responding (${msg}). Reload the page to carry on.`, 'error');
        };
        if (agent) void this.mountDeviceCompiler(vp);
        if (params.has('rung')) vp.pin(Number(params.get('rung')));
        vp.start();
        // Films a closed or crashed tab left in OPFS, and finished films no tab is showing (film.ts).
        void sweepFilms().then(removed => { if (removed.length) console.info(`Wexy: removed ${removed.length} old film(s) from this browser's storage`); });
        this.forgeBtn.disabled = false;

        // A starter named in the URL is a playground example, whatever client this build has.
        if (params.has('autorun') || params.has('scene') || params.has('capture')) await this.forge(starter || !this.live ? 'mock' : 'live');
        if (params.has('t') && this.viewport) {
            this.seek(Number(params.get('t')));
            this.setPlaying(false);
        }
        if (params.has('guide') && this.runtime) this.setGuide(params.get('guide') !== '0');
    }

    /**
     * ?agent=1: the agent turn in Developer view (EA2.5), beside h1's own Create, which it leaves as it is, and a hand-off's
     * candidate beneath it (EA4.5: its modules written by the module route, a program revision by a turn with a base).
     * Its code loads only then, so the creator's page carries none of it, and it is handed the idea's fields, never the world.
     */
    private async mountAgent(api: Api | null): Promise<void> {
        const [{ AgentPanel }, { createAgentClient }, { createModuleClient }, { createReviser }] = await Promise.all([
            import('./agent-view'), import('../../forge-client/agent-client'), import('../../forge-client/module-client'), import('../../loop/reviser'),
        ]);
        const client = api ? createAgentClient(api) : null;
        const panel = new AgentPanel(client, () => ({
            prompt: this.prompt.value, style: this.style.value as Style | 'auto', seconds: this.duration,
        }), {
            candidate: api && client ? { modules: createModuleClient(api), revise: createReviser(client), compiler: () => this.deviceCompiler } : undefined,
        });
        this.candidatePanel = panel.candidate;
        panel.el.classList.add('dev-only');
        $('#left').insertBefore(panel.el, this.trace.el);
    }

    /**
     * ?agent=1: L3 on this device (EA5.1). The compiler is handed the viewport's GPUDevice and nothing else; every body
     * it compiles passed L1 and L2 first, and compiling runs nothing on the GPU. Its code loads only then.
     */
    private async mountDeviceCompiler(vp: Viewport): Promise<void> {
        const { createDeviceCompiler } = await import('../../exec/device-compiler');
        this.deviceCompiler = createDeviceCompiler(vp.engine.device, { generation: () => this.deviceGeneration, gpu: vp.gpuLabel });
        this.candidatePanel?.refresh();
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
            b.addEventListener('click', () => { this.prompt.value = s.prompt; this.prompt.dispatchEvent(new Event('input')); void this.forge('mock'); });
            return b;
        }));
        this.forgeBtn.disabled = true;
        this.forgeBtn.addEventListener('click', () => void this.forge(this.live ? 'live' : 'mock'));
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
            b.addEventListener('click', () => { this.prompt.value = s.prompt; this.prompt.dispatchEvent(new Event('input')); void this.forge('mock'); });
            return b;
        });
        this.empty.replaceChildren(h('div', { class: 'empty-card' },
            h('span', { class: 'empty-logo', html: logo(64) }),
            h('h3', null, 'Describe a world'),
            h('p', { class: 'empty-building', role: 'status' }, 'Follow the steps on the left'),
            h('p', { class: 'empty-lede' }, 'Type an idea on the left, or tap one below. It turns into a living 3D world you can fly around, and then into a video.'),
            h('div', { class: 'empty-examples' }, chips),
        ));
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
    private restoreControls(): void {
        if (this.runtime && this.viewport) this.director.bind(this.runtime, this.viewport);
        else this.director.clear();
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
        const prompt = this.prompt.value.trim();
        if (!prompt) { this.prompt.focus(); return; }
        const client = source === 'mock' || !this.live ? this.mock : this.live;
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
            this.install(world, spec, false, client.source);
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
            this.setBusy(false);
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

    private install(runtime: SceneRuntime, spec: SceneSpec, keepCamera: boolean, source: Source): void {
        const vp = this.viewport!;
        const old = this.runtime;
        const previousParams = old && keepCamera ? old.uniformNames.map(n => [n, old.getParam(n)] as const) : [];
        this.runtime = runtime;
        this.spec = spec;
        this.source = source;
        this.draftSpec = structuredClone(spec);
        this.draftIsLive = true;
        this.editedTargets.clear();
        for (const [name, v] of previousParams) runtime.setParam(name, v);

        vp.setRuntime(runtime);
        // Destroy after the swap: the old world kept rendering while the new one was checked and built (L8).
        old?.destroy();
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
            this.install(result.world, result.spec, sameScene, this.source);
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                this.trace.add('Hot-swap stopped', 'gate').error(String(error));
                this.showMessage(COPY.editFailed, 'error');
            }
        } finally {
            if (this.abort === ac) this.abort = null;
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
        this.forgeBtn.disabled = busy || !this.viewport;
        this.forgeBtn.classList.toggle('is-busy', busy);
        this.forgeBtn.querySelector('span')!.textContent = busy ? 'Creating…' : 'Create world';
        this.setBuilding(busy);
        this.swapBtn.disabled = busy || !this.draftSpec || (this.editedTargets.size === 0 && this.draftIsLive);
    }

    /** While the empty stage waits for a first world, the mark turns (public/loader1.mp4). */
    private setBuilding(busy: boolean): void {
        const mark = this.empty.querySelector<HTMLElement>('.empty-logo:not(.warn)');
        if (!mark || this.empty.classList.contains('is-building') === busy) return;
        this.empty.classList.toggle('is-building', busy);
        mark.innerHTML = busy ? loader(1, 132) : logo(64);
        const title = this.empty.querySelector('h3');
        if (title) title.textContent = busy ? 'Making your world' : 'Describe a world';
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
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !this.exporter.el.open) { e.preventDefault(); void this.forge(this.live ? 'live' : 'mock'); return; }
            if (isTyping() || e.ctrlKey || e.metaKey || e.altKey || this.exporter.el.open) return;
            if (e.key === ' ' && this.runtime) { e.preventDefault(); this.setPlaying(!this.timeline.isPlaying); }
            else if (e.key.toLowerCase() === 'k' && this.runtime) this.addKeyframe();
            else if (e.key.toLowerCase() === 'p' && this.runtime) void this.takeSnapshot();
            else if (e.key.toLowerCase() === 'r' && this.runtime) this.openExport();
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
            : `${icon('orbit', 12)}<span>Drag to look around · scroll to zoom · K saves the view</span>`;
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

    private openExport(): void {
        const vp = this.viewport, rt = this.runtime, spec = this.spec;
        if (!vp || !rt || !spec) return;
        this.setPlaying(false);
        this.exporter.open({
            viewport: vp,
            runtime: rt,
            spec,
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
        const vp = this.viewport, rt = this.runtime, spec = this.spec;
        if (!vp || !rt || !spec || this.busy || document.body.classList.contains('exporting')) return;
        const { width, height } = frameSize(this.format, 'fhd');
        // A photo of the live state on an engine of its own; the preview waits, untouched (film.ts).
        const resume = vp.pause();
        let png: Blob;
        try {
            ({ png } = await snapshotLive(vp.engine.device, rt, width, height, vp.currentView()));
        } catch (e) {
            this.showMessage(`The photo could not be taken: ${(e as Error).message.replace(/^film: /, '')}`, 'error');
            return;
        } finally {
            resume();
        }
        const name = `${spec.title.split(':')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${this.format}-${Date.now()}.png`;
        download(png, name);
        const file = new File([png], name, { type: 'image/png' });
        const f = formatById(this.format);
        this.showToast(`Photo saved · ${f.label} ${f.ratio}`, canShareFile(file) ? () => void shareFile(file, spec.title) : null);
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
