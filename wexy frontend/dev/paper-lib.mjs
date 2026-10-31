// The paper test's checks (the engine-aware design §13): one answer of the backend's paper probe (forge-service's
// PaperProbe, schema paper-action.v1) against the engine bundle it quoted. Failures: a name that is not an export
// of its family in K; a member its export does not declare; a family Wexy cannot run; a WGSL reserved word naming a
// module's entry or a parameter; a bind group past the fourth; an instance buffer feeding a stock material that is
// not 14 floats a stride. Warnings, for the person who reads the plan: a host-only family, a group the engine owns,
// a document or an id that is not there, an answer of another kind than the plan asked for. Node only (dev tools).
import { DOCS } from '../src/contract/engine/docs.ts';
import { ENGINE } from '../src/contract/engine/index.ts';
import { RESERVED_WORDS } from '../src/contract/reserved.ts';

const BY_ID = new Map(ENGINE.capabilities.symbols.map(s => [s.id, s]));
const FAMILIES = new Map(ENGINE.capabilities.families.map(f => [f.id, f]));
const DOC_IDS = new Set(DOCS.docs.map(d => d.id));
const FAMILY_OF_NAME = new Map(ENGINE.capabilities.symbols.map(s => [s.name, s.family]));
const STOCK = new Set(['BasicMaterial', 'LambertMaterial', 'EmissiveMaterial', 'MatcapMaterial', 'ToonMaterial', 'StandardPBRMaterial']
    .map(n => `materials:${n}`));
/** The NullGraph calls that hand a batch its instances, geometry, material or bindings. */
const BATCH_MEMBERS = new Set(['createBatch', 'setBatchGeometry', 'updateBatchData', 'setRenderPassBindGroup', 'createTextureBindGroup']);
/** What a binding at group 0, 2 or 3 may be: the engine's own camera, instances, lights, environment or shadows. */
const ENGINE_OWNED = /camera|instance|light|environment|probe|shadow/i;

/** Whether an export declares `member`: a method, property or accessor in its declaration as written. */
export function declaresMember(symbol, member) {
    const name = member.replace(/\$/g, '\\$');
    return new RegExp(`(^|[\\s;{(,])(?:readonly\\s+|static\\s+|get\\s+|set\\s+|async\\s+)*${name}\\s*[(<:?!]`, 'm').test(symbol.declaration);
}

/** Why a name is not an export, when the bundle can tell: no family part, another family, or no such family. */
function hint(ref) {
    const [family, name] = ref.includes(':') ? ref.split(':') : [null, ref];
    if (family === null) return FAMILY_OF_NAME.has(ref) ? ` (write it as ${FAMILY_OF_NAME.get(ref)}:${ref})` : ' (not family:Name)';
    if (!FAMILIES.has(family)) return ` (null-graph has no family ${family})`;
    if (FAMILY_OF_NAME.has(name)) return ` (${name} is in ${FAMILY_OF_NAME.get(name)}, not ${family})`;
    return '';
}

/** The names a module gives: its entry, its function's name and its parameters' (attributes dropped, types not names). */
export function moduleNames(entry, signature) {
    const names = [entry];
    const m = /fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(String(signature).replace(/@\w+(\([^)]*\))?/g, ''));
    if (m) {
        names.push(m[1]);
        for (const p of m[2].split(',')) {
            const name = p.split(':')[0].trim();
            if (name) names.push(name);
        }
    }
    return [...new Set(names.filter(Boolean))];
}

/** The findings for one parsed paper action, each { level: 'fail' | 'warn', code, message }, in a stable order. */
export function checkAnswer(action) {
    const findings = [];
    const fail = (code, message) => findings.push({ level: 'fail', code, message });
    const warn = (code, message) => findings.push({ level: 'warn', code, message });
    const design = action.design ?? null;
    const program = action.program ?? null;
    if (action.kind !== 'propose_design_and_program') warn('kind', `answered ${action.kind}, not the plan asked for`);

    // Names: every technique's symbols and every object's, with the object's member.
    const named = [];
    (design?.techniques ?? []).forEach((t, i) => { for (const ref of t.symbols ?? []) named.push({ where: `design.techniques[${i}]`, ref }); });
    for (const o of program?.objects ?? []) named.push({ where: `program.objects.${o.id}`, ref: o.symbol, member: o.member });
    const used = new Set();
    for (const n of named) {
        const symbol = BY_ID.get(n.ref);
        if (!symbol) {
            fail('name', `${n.where}: ${n.ref} is not an export of null-graph ${ENGINE.bundle.engine.version}${hint(n.ref)}`);
            continue;
        }
        used.add(symbol.family);
        if (n.member == null) continue;
        if (symbol.kind === 'function' || symbol.kind === 'const') fail('member', `${n.where}: ${n.ref} is a ${symbol.kind}, with no member ${n.member}`);
        else if (!declaresMember(symbol, n.member)) fail('member', `${n.where}: ${n.ref} declares no member ${n.member}`);
    }
    for (const id of [...used].sort()) {
        const family = FAMILIES.get(id);
        if (family.use === 'host') warn('host', `the world uses ${id}, the host's: ${family.reason}`);
        if (family.use === 'external') fail('external', `the world uses ${id}, which Wexy cannot run: ${family.reason}`);
    }
    (design?.techniques ?? []).forEach((t, i) => {
        for (const d of t.docIds ?? []) if (!DOC_IDS.has(d)) warn('doc', `design.techniques[${i}]: no document ${d} in the bundle`);
    });

    // Modules: names WGSL reserves, and the four bind groups.
    for (const m of program?.modules ?? []) {
        for (const word of moduleNames(m.entry, m.signature)) if (RESERVED_WORDS.has(word)) fail('reserved', `module ${m.id}: ${word} is a reserved word in WGSL`);
        for (const b of m.bindings ?? []) {
            if (b.group > 3) fail('group', `module ${m.id}: group ${b.group}, but WebGPU gives four (0 to 3)`);
            else if (m.stage === 'compute' && b.group !== 0) warn('group', `module ${m.id}: a compute stage binds its own resources at group 0 (setComputePassBindGroup's default), not ${b.group}`);
            else if (m.stage !== 'compute' && b.group !== 1 && !ENGINE_OWNED.test(b.resource)) {
                warn('group', `module ${m.id}: ${b.resource} at group ${b.group}, which the engine owns (0 camera and instances, 2 lights and environment, 3 shadows); a batch's own bindings go at group 1`);
            }
        }
    }

    // The 14-float stock layout: a storage buffer handed to a batch, in a program that draws with a stock material.
    const objects = program?.objects ?? [];
    if (objects.some(o => STOCK.has(o.symbol))) {
        for (const r of program?.resources ?? []) {
            if (r.kind !== 'storage_buffer') continue;
            if (!objects.some(o => o.symbol === 'core:NullGraph' && BATCH_MEMBERS.has(o.member) && (o.inputs ?? []).includes(r.id))) continue;
            if (r.strideFloats == null) warn('stride', `resource ${r.id} feeds a batch beside a stock material and gives no strideFloats (the stock materials read 14)`);
            else if (r.strideFloats !== 14) fail('stride', `resource ${r.id} is ${r.strideFloats} floats a stride; the stock materials read 14${r.strideFloats === 24 ? " (24 is the visibility family's layout)" : ''}`);
        }
    }

    // Ids that point nowhere.
    const ids = new Set([...objects.map(o => o.id), ...(program?.resources ?? []).map(r => r.id), ...(program?.modules ?? []).map(m => m.id)]);
    for (const o of objects) for (const i of o.inputs ?? []) if (!ids.has(i)) warn('id', `program.objects.${o.id}: input ${i} is declared nowhere`);
    for (const s of program?.schedule ?? []) if (!ids.has(s.objectId)) warn('id', `schedule ${s.id}: object ${s.objectId} is declared nowhere`);
    for (const m of program?.modules ?? []) if (!ids.has(m.usedBy)) warn('id', `module ${m.id}: usedBy ${m.usedBy} is declared nowhere`);
    return findings;
}

/** How many engine names an answer gives, and how many of them are distinct. */
export function nameCount(action) {
    const refs = [
        ...(action.design?.techniques ?? []).flatMap(t => t.symbols ?? []),
        ...(action.program?.objects ?? []).map(o => o.symbol),
    ];
    return { total: refs.length, distinct: new Set(refs).size };
}

export const REPORT_BEGIN = '===== WEXY PAPER REPORT BEGIN =====';
export const REPORT_END = '===== WEXY PAPER REPORT END =====';

/** The report from its JSON, or from the host's log, where it is printed whole between two marker lines. */
export function readReport(text) {
    const begin = text.indexOf(REPORT_BEGIN);
    if (begin < 0) return JSON.parse(text);
    const end = text.indexOf(REPORT_END, begin);
    if (end < 0) throw new Error('the log has the report\'s first marker but not its last: the run was cut short, or the copy is');
    return JSON.parse(text.slice(begin + REPORT_BEGIN.length, end));
}

/** An answer's text as an action: JSON, from inside a code fence if a model fenced it; null when it is not JSON. */
export function parseAction(text) {
    let t = String(text ?? '').trim();
    if (t.startsWith('```')) t = t.slice(t.indexOf('\n') + 1).replace(/```\s*$/, '');
    try {
        const v = JSON.parse(t);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}
