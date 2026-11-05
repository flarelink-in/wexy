// The film timeline: a scrubbable playhead over the film's duration, the spec's camera keyframes
// as diamonds ("saved views"), and the switch between free look and the Catmull-Rom camera move.

import type { CameraMode } from '../../runtime/viewport';
import { h } from '../../shared/dom';
import { fmtClock } from '../../shared/format';
import { icon } from '../../shared/icons';
import type { CameraKeyframe } from '../../contract/spec';

export class Timeline {
    readonly el: HTMLElement;
    onSeek?: (seconds: number) => void;
    onTogglePlay?: () => void;
    onAddKey?: () => void;
    onRemoveKey?: (index: number) => void;
    onSelectKey?: (index: number) => void;
    onMode?: (mode: CameraMode) => void;
    onFilmGate?: (on: boolean) => void;

    private readonly playBtn: HTMLButtonElement;
    private readonly time: HTMLElement;
    private readonly timeNow = h('b');
    private timeLabel = '';
    private readonly track: HTMLElement;
    private readonly ruler: HTMLElement;
    private readonly lane: HTMLElement;
    private readonly head: HTMLElement;
    private readonly modeBtns: Record<CameraMode, HTMLButtonElement>;
    private readonly keyInfo: HTMLElement;
    private readonly removeBtn: HTMLButtonElement;
    private readonly gateBtn: HTMLButtonElement;
    private duration = 12;
    private keys: CameraKeyframe[] = [];
    /** How many saved views the world keeps: Remove is off at that many. */
    private fewest = 1;
    private selected = -1;
    private playing = false;

    constructor() {
        this.playBtn = h('button', { type: 'button', class: 'icon-btn tl-play', 'aria-label': 'Play film timeline (Space)', title: 'Play / pause (Space)', html: icon('play', 15) });
        this.playBtn.addEventListener('click', () => this.onTogglePlay?.());
        this.time = h('span', { class: 'tl-time' });

        const mode = (m: CameraMode, label: string, ic: 'orbit' | 'route', title: string) => {
            const b = h('button', { type: 'button', role: 'radio', title, html: `${icon(ic, 13)}<span>${label}</span>` });
            b.addEventListener('click', () => this.onMode?.(m));
            return b;
        };
        this.modeBtns = {
            orbit: mode('orbit', 'Free look', 'orbit', 'Drag to look around, scroll to zoom'),
            path: mode('path', 'Camera move', 'route', 'Play the camera move your video will use'),
        };
        const addKey = h('button', { type: 'button', class: 'btn btn-sm', title: 'Save this camera view at this moment of the film (K). The camera glides between saved views.', html: `${icon('diamond', 12)}<span>Save view</span><kbd>K</kbd>` });
        addKey.addEventListener('click', () => this.onAddKey?.());
        this.removeBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet tl-remove', 'aria-label': 'Remove the selected view', title: 'Remove the selected view (Delete)', html: `${icon('x', 12)}<span>Remove</span>` });
        this.removeBtn.addEventListener('click', () => { if (this.selected >= 0) this.onRemoveKey?.(this.selected); });
        this.keyInfo = h('span', { class: 'tl-hint' });
        this.gateBtn = h('button', { type: 'button', class: 'btn btn-sm btn-quiet tl-guide', 'aria-pressed': 'false', 'aria-label': 'Frame guide', title: 'Show exactly what the photo or video will include', html: `${icon('gate', 13)}<span>Frame guide</span>` });
        this.gateBtn.addEventListener('click', () => this.onFilmGate?.(this.gateBtn.getAttribute('aria-pressed') !== 'true'));

        this.ruler = h('div', { class: 'tl-ruler' });
        this.lane = h('div', { class: 'tl-lane' });
        this.head = h('div', { class: 'tl-head' }, h('span'));
        this.track = h('div', { class: 'tl-track', role: 'slider', tabindex: '0', 'aria-label': 'Film time' }, this.ruler, this.lane, this.head);
        this.el = h('div', { class: 'timeline' },
            h('div', { class: 'tl-bar' },
                this.playBtn, this.time,
                h('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Camera mode' }, this.modeBtns.orbit, this.modeBtns.path),
                addKey, this.removeBtn, this.keyInfo,
                h('span', { class: 'grow' }),
                this.gateBtn,
            ),
            this.track,
        );
        this.bindScrub();
        this.setDuration(12);
        this.setMode('orbit');
        this.setKeyframes([]);
    }

    setDuration(seconds: number): void {
        this.duration = seconds;
        this.time.replaceChildren(this.timeNow, ` / ${fmtClock(seconds, true)}`);
        this.timeLabel = '';
        const major = seconds > 24 ? 5 : seconds > 10 ? 2 : 1;
        // The last label reads to the left of its tick (studio.css); on a dense ruler the one before it gives way on a phone.
        const crowded = seconds / major >= 8 ? Math.floor(seconds / major) * major - major : -1;
        const ticks: Node[] = [];
        for (let s = 0; s <= seconds + 1e-6; s += 1) {
            const isMajor = s % major === 0;
            ticks.push(h('span', { class: isMajor ? `tick major${s === crowded ? ' crowded' : ''}` : 'tick', style: `left:${(s / seconds) * 100}%` }, isMajor ? `${s}s` : ''));
        }
        this.ruler.replaceChildren(...ticks);
        this.renderKeys();
    }

    /**
     * The world's saved views. `fewest` is how many it keeps (Remove is off at that many): h1's path needs one; an agent
     * world's keyframes are the studio's, and it may have none (Q119 (a), EA9.4).
     */
    setKeyframes(keys: CameraKeyframe[], fewest = 1): void {
        this.keys = keys;
        this.fewest = fewest;
        if (this.selected >= keys.length) this.selected = -1;
        this.renderKeys();
    }

    select(index: number): void {
        this.selected = index;
        this.renderKeys();
    }

    setPlayhead(seconds: number): void {
        const t = Math.min(1, Math.max(0, seconds / this.duration));
        this.head.style.setProperty('--t', t.toFixed(5));
        // Called every frame: touch the text only when the tenths change.
        const label = fmtClock(seconds, true);
        if (label !== this.timeLabel) {
            this.timeLabel = label;
            this.timeNow.textContent = label;
            this.track.setAttribute('aria-valuenow', seconds.toFixed(1));
        }
    }

    setPlaying(playing: boolean): void {
        this.playing = playing;
        this.playBtn.innerHTML = icon(playing ? 'pause' : 'play', 15);
        this.playBtn.classList.toggle('on', playing);
    }

    get isPlaying(): boolean {
        return this.playing;
    }

    setMode(mode: CameraMode): void {
        for (const [m, b] of Object.entries(this.modeBtns)) b.setAttribute('aria-checked', String(m === mode));
    }

    setFilmGate(on: boolean): void {
        this.gateBtn.setAttribute('aria-pressed', String(on));
    }

    private renderKeys(): void {
        this.lane.replaceChildren(...this.keys.map((k, i) => {
            const b = h('button', {
                type: 'button', class: `tl-key${i === this.selected ? ' sel' : ''}`, style: `left:${k.t * 100}%`,
                title: `View ${i + 1} at ${(k.t * this.duration).toFixed(1)} s`,
                html: icon('diamond', 12),
            });
            b.addEventListener('pointerdown', e => e.stopPropagation());
            b.addEventListener('click', () => this.onSelectKey?.(i));
            return b;
        }));
        this.removeBtn.disabled = this.selected < 0 || this.keys.length <= this.fewest;
        this.keyInfo.textContent = this.keys.length
            ? `${this.keys.length} saved view${this.keys.length === 1 ? '' : 's'} · the camera glides between them`
            : 'no saved views';
    }

    private bindScrub(): void {
        const seek = (clientX: number) => {
            // The ruler, lane and head are inset 10 px on each side of the track.
            const r = this.track.getBoundingClientRect();
            const t = Math.min(1, Math.max(0, (clientX - r.left - 10) / (r.width - 20)));
            this.onSeek?.(t * this.duration);
        };
        this.track.addEventListener('pointerdown', e => {
            this.track.setPointerCapture(e.pointerId);
            seek(e.clientX);
            const move = (ev: PointerEvent) => seek(ev.clientX);
            const up = () => {
                this.track.removeEventListener('pointermove', move);
                this.track.removeEventListener('pointerup', up);
                this.track.removeEventListener('pointercancel', up);
            };
            this.track.addEventListener('pointermove', move);
            this.track.addEventListener('pointerup', up);
            this.track.addEventListener('pointercancel', up);
        });
        this.track.addEventListener('keydown', e => {
            const now = Number(this.track.getAttribute('aria-valuenow') ?? 0);
            if (e.key === 'ArrowRight') this.onSeek?.(Math.min(this.duration, now + 0.5));
            else if (e.key === 'ArrowLeft') this.onSeek?.(Math.max(0, now - 0.5));
            else return;
            e.preventDefault();
        });
    }
}
