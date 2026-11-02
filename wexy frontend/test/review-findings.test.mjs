// EA-VR2 and EA-VR10, the host's findings, headless (EA6.1; visual-review-design.md §7, §10): detector profile
// `visual-host.v1` over given boxes and pixels. No GPU.
//   EA-VR2  the castle as the agent wrote it: EA_SCALE and EA_FRAME; a dark frame: EA_DARK; a washed-out one: EA_BLOWN;
//           a backdrop alone: EA_EMPTY; the castle at unit sizes: none, and a pass only when every check ran
//   EA-VR10 the thresholds pinned at and past their values; a tie for the dominant colour; a portrait frame judged without
//           its bars; boxes sampled, from preparation, or none; a night, a snowfield and sparse particles, which fire
//           (warnings a creator may overrule); a missing view or frame never passes; the same inputs, the same findings
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameWorld } from '../src/exec/bounds.ts';
import { fitInto } from '../src/exec/review-capture.ts';
import { BLOWN_MEAN, DARK_MAX, DETECTOR, EMPTY_FRACTION, hostLook, lookAt } from '../src/exec/review-findings.ts';

const box = (min, max) => ({ min, max });
/** The castle's boxes (bounds.test.mjs): its hill as written, a 468 × 104 × 468 shell, or at size 1. */
const castle = written => ({
    batches: [
        { node: 'batchhill', box: written ? box([-234, -54, -234], [234, 50, 234]) : box([-9, -4, -9], [9, 0, 9]), instances: 1, sampled: 1 },
        { node: 'batchtower', box: box([-7.9, -2.9, -7.9], [7.9, 13.9, 7.9]), instances: 6, sampled: 6 },
        { node: 'batchstone', box: box([-6.3, 2, -6.3], [6.3, 6, 10]), instances: 80, sampled: 80 },
        { node: 'batchroof', box: box([-8, 6.3, -8], [8, 14.7, 8]), instances: 6, sampled: 6 },
        { node: 'batchflag', box: box([-6.5, 12, -6.5], [6.5, 16, 6.5]), instances: 6, sampled: 6 },
    ],
});

/** A 768 × 432 frame from `pixel(x, y)` (RGB), opaque. */
function frame(pixel, width = 768, height = 432) {
    const p = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) p.set([...pixel(x, y), 255], (y * width + x) * 4);
    return p;
}
const FULL = { x: 0, y: 0, width: 768, height: 432 };
const look = (view, pixel) => lookAt(view, frame(pixel), 768, FULL);
/** A world as a world looks: a grey ground, a coloured subject on a third of the frame. */
const scene = (x, y) => (x > 256 && x < 512 && y > 100 ? [180, 120, 60] : y > 300 ? [70, 70, 70] : [40, 60, 120]);
const PROBE = { warnings: [], gpu: 'Fake GPU', width: 2022, height: 1137 };

/** hostLook with everything measured and clean, `over` changing any of it. */
function judged(over = {}) {
    const bounds = over.bounds === undefined ? castle(false) : over.bounds;
    const framing = bounds ? frameWorld(bounds, 45, 16 / 9) : null;
    return hostLook({
        looks: [look('framed', scene), look('side', scene)], missing: [], bounds, boundsAt: { when: 'capture', tick: 120, error: null },
        framed: framing?.view ?? null, aspect: 16 / 9, unboxed: [], probe: PROBE, ...over,
    });
}

test('EA-VR2 the castle as written: EA_SCALE and EA_FRAME; a dark frame: EA_DARK; a washed-out one: EA_BLOWN; a backdrop alone: EA_EMPTY; the castle at size 1: nothing', () => {
    // The castle as the agent wrote it, framed as the studio frames it: its hill dwarfs the rest, and the camera is inside it.
    const written = judged({ bounds: castle(true) });
    assert.deepEqual(written.findings.map(f => f.code), ['EA_SCALE', 'EA_FRAME']);
    assert.equal(written.findings[0].message, 'batchhill spans 468 × 104 × 468 units, 29 times the rest of the world (16 across): a primitive\'s size and its instances\' scale multiply, so one of them is likely meant as 1 (boxes read at tick 120)');
    assert.equal(written.findings[1].message, 'the framed view\'s camera is inside batchhill\'s bounding box (468 × 104 × 468 units): its geometry may block the view (boxes read at tick 120)');
    assert.equal(written.verdict, 'fail');
    // A dark world with something in it: its brightest pixel under 8%.
    const dark = judged({ looks: [look('framed', (x, y) => ((x * y) % 7 === 0 ? [19, 20, 19] : [2, 2, 3])), look('side', scene)] });
    assert.deepEqual(dark.findings.map(f => f.code), ['EA_DARK']);
    assert.match(dark.findings[0].message, /^the framed view's brightest pixel is 7\.\d% of white, under 8\.0%: the world is drawn too dark to see$/);
    // A washed-out one, with something in it: its mean over 92%.
    const blown = judged({ looks: [look('framed', (x, y) => ((x + y) % 10 === 0 ? [200, 200, 200] : [255, 255, 255])), look('side', scene)] });
    assert.deepEqual(blown.findings.map(f => f.code), ['EA_BLOWN']);
    // The sky alone, in both views: almost uniform, the subject may be missing.
    const empty = judged({ looks: [look('framed', () => [40, 60, 120]), look('side', () => [40, 61, 121])] });
    assert.deepEqual(empty.findings.map(f => f.code), ['EA_EMPTY']);
    assert.equal(empty.findings[0].message, '0.0% of the framed view\'s and 0.0% of the side view\'s pixels differ from its dominant colour, under 2.0%: the views are almost uniform, and the subject may be missing');
    // The castle at unit sizes, everything measured: nothing to say, and only then a pass.
    const designed = judged();
    assert.deepEqual([designed.findings, designed.gaps, designed.verdict, designed.detector], [[], [], 'pass', DETECTOR]);
});

test('EA-VR10 the thresholds at and past their values, a tie for the dominant colour, and a portrait frame judged without its bars', () => {
    const with_ = (framed, side = { ...framed, view: 'side' }) => judged({ looks: [{ view: 'framed', dominant: [0, 0, 0], pixels: 1, ...framed }, side] }).findings.map(f => f.code);
    const plain = { mean: 0.5, max: 0.9, differing: 0.5 };
    assert.deepEqual(with_({ ...plain, max: DARK_MAX }), [], 'a brightest pixel at 8% exactly is not dark');
    assert.deepEqual(with_({ ...plain, max: DARK_MAX - 1e-9 }), ['EA_DARK']);
    assert.deepEqual(with_({ ...plain, mean: BLOWN_MEAN }), [], 'a mean at 92% exactly is not washed out');
    assert.deepEqual(with_({ ...plain, mean: BLOWN_MEAN + 1e-9 }), ['EA_BLOWN']);
    assert.deepEqual(with_({ ...plain, differing: EMPTY_FRACTION }), [], 'at 2% exactly the views are not empty');
    assert.deepEqual(with_({ ...plain, differing: EMPTY_FRACTION - 1e-9 }), ['EA_EMPTY']);
    assert.deepEqual(with_({ ...plain, differing: 0 }, { ...plain, view: 'side', differing: 0.3 }), [], 'every view there is must be almost uniform');
    // Half black, half white: the two bins tie, the lower index (black) wins, and half the pixels differ from it.
    const tie = look('framed', x => (x < 384 ? [0, 0, 0] : [255, 255, 255]));
    assert.deepEqual([tie.dominant, tie.differing], [[0, 0, 0], 0.5]);
    // A pixel differs past 16 steps on its farthest channel, not at 16.
    assert.equal(look('framed', x => (x < 384 ? [100, 100, 100] : [116, 100, 100])).differing, 0, '16 steps away is the same colour');
    assert.equal(look('framed', x => (x < 384 ? [100, 100, 100] : [117, 100, 100])).differing, 0.5, '17 steps away differs');
    // A portrait world fitted between black bars: judged on its content alone, so a white world is washed out, not grey.
    const portrait = fitInto(new Uint8Array(720 * 1280 * 4).fill(255), 720, 1280);
    const white = lookAt('framed', portrait.rgba, 768, portrait.content);
    assert.ok(Math.abs(white.mean - 1) < 1e-9 && Math.abs(white.max - 1) < 1e-9, `white is white: ${white.mean}, ${white.max}`);
    assert.equal(white.pixels, 243 * 432, 'its content alone');
    const whole = lookAt('framed', portrait.rgba, 768, FULL);
    assert.ok(whole.mean < 0.4, `with its bars it would read ${whole.mean}`);
});

test('EA-VR10 boxes sampled, from preparation, or none; a missing view or frame; a probe\'s slow frame; unboxed batches: what was not measured never passes', () => {
    const sampled = castle(false);
    sampled.batches[2] = { ...sampled.batches[2], instances: 10000, sampled: 4096 };
    const s = judged({ bounds: sampled });
    assert.deepEqual([s.verdict, s.notes], ['pass', ['batchstone\'s box is from 4096 of its 10000 instances, sampled']], 'a sample is a measurement, said');
    const prepared = judged({ boundsAt: { when: 'preparation', tick: null, error: 'a read failed' } });
    assert.deepEqual([prepared.verdict, prepared.gaps], ['unverified', ['the mesh boxes are the preparation\'s, not the captured tick\'s: EA_SCALE and EA_FRAME describe the world before it ran']]);
    const stalePrepared = judged({ bounds: castle(true), boundsAt: { when: 'preparation', tick: null, error: null } });
    assert.match(stalePrepared.findings[0].message, /\(boxes from the world's preparation, before it ran\)$/, 'a finding from old boxes says so');
    const none = judged({ bounds: null, boundsAt: { when: 'none', tick: null, error: 'this engine cannot read them' } });
    assert.deepEqual([none.verdict, none.gaps], ['unverified', ['no mesh boxes (this engine cannot read them): EA_SCALE and EA_FRAME unverified']]);
    const oneView = judged({ looks: [look('framed', scene)], missing: [{ name: 'side', why: 'no mesh boxes, so no subject to look at level' }] });
    assert.deepEqual([oneView.verdict, oneView.gaps], ['unverified', ['no side view (no mesh boxes, so no subject to look at level): EA_EMPTY judged on one view, a partial result']]);
    const noFrames = judged({ looks: [], missing: [{ name: 'framed', why: 'EA_CAPTURE_UNAVAILABLE state: x' }, { name: 'side', why: 'EA_CAPTURE_UNAVAILABLE state: x' }] });
    assert.deepEqual([noFrames.verdict, noFrames.gaps], ['unverified', ['no framed view (EA_CAPTURE_UNAVAILABLE state: x): EA_DARK and EA_BLOWN unverified', 'no frames: EA_EMPTY unverified']]);
    const unboxed = judged({ unboxed: ['sparks'] });
    assert.deepEqual([unboxed.verdict, unboxed.gaps], ['unverified', ['sparks draw where their own code puts them, with no box: EA_SCALE and EA_FRAME do not see them']]);
    const noProbe = judged({ probe: null });
    assert.deepEqual([noProbe.verdict, noProbe.gaps], ['unverified', ['no probe report: EA_SLOW unverified']]);
    // The probe's own warning, said as the probe measured it, never as a measurement of this capture.
    const slow = judged({ probe: { ...PROBE, warnings: ['EA_SLOW 48.0 ms a steady frame here, over the 33 ms target', 'the Head shared the queue while this measured: its work is in every timing, never subtracted'] } });
    assert.deepEqual(slow.findings.map(f => f.code), ['EA_SLOW']);
    assert.equal(slow.findings[0].message, '48.0 ms a steady frame here, over the 33 ms target (the probe\'s measurement on Fake GPU at 2022×1137 when the world was admitted, not measured again for this review)');
    // A camera above the hill, inside its box's width and depth but not its height: not inside it.
    const above = judged({ bounds: castle(true), framed: { target: [0, 60, 0], distance: 40, azimuth: 0, polar: 0, fov: 45 } });
    assert.deepEqual(above.findings.map(f => f.code), ['EA_SCALE'], 'inside on two axes of three is outside');
    // Deterministic: the same inputs, the same findings.
    assert.deepEqual(judged({ bounds: castle(true) }), judged({ bounds: castle(true) }));
});

test('EA-VR10 worlds meant to look so: a night fires EA_DARK, a snowfield EA_BLOWN, sparse particles EA_EMPTY; warnings, never refusals, for the creator to overrule', () => {
    const night = judged({ looks: [look('framed', (x, y) => (y > 380 ? [12, 14, 20] : (x * 7 + y * 13) % 97 === 0 ? [18, 18, 22] : [1, 1, 4])), look('side', scene)] });
    assert.deepEqual(night.findings.map(f => f.code), ['EA_DARK'], 'a night with no light in it reads as too dark');
    const field = (x, y) => (y < 60 ? [220, 230, 245] : [250, 250, 252]);
    const snow = judged({ looks: [look('framed', field), look('side', field)] });
    assert.deepEqual(snow.findings.map(f => f.code), ['EA_BLOWN'], 'a white field under a pale sky: washed out; its sky, 14% of the frame, keeps it from empty');
    const sparks = (x, y) => ((x * 31 + y * 17) % 211 === 0 ? [255, 210, 120] : [0, 0, 0]);
    const sparse = judged({ looks: [look('framed', sparks), look('side', sparks)] });
    assert.deepEqual(sparse.findings.map(f => f.code), ['EA_EMPTY'], 'particles on less than 2% of the frame');
    for (const j of [night, snow, sparse]) assert.equal(j.verdict, 'fail', 'a heuristic fired: a warning, the world still on the stage');
});
