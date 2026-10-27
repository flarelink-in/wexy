export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

export function fmtMs(ms: number): string {
    if (ms < 10) return `${ms.toFixed(1)} ms`;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** m:ss for durations, with tenths under a minute when asked. */
export function fmtClock(seconds: number, tenths = false): string {
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    const sec = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
    return `${String(m).padStart(2, '0')}:${sec}`;
}

export function fmtBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtUsd(usd: number): string {
    if (usd === 0) return '$0.00';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

export function fmtNum(v: number, step = 0.01): string {
    const decimals = Math.max(0, Math.min(3, Math.ceil(-Math.log10(step))));
    return v.toFixed(decimals);
}
