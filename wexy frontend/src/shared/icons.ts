// Inline stroke icons (24-unit grid, currentColor), so they inherit text color and need no requests.

const paths: Record<string, string> = {
    play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    diamond: '<path d="M12 3.5 20.5 12 12 20.5 3.5 12Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>',
    download: '<path d="M12 15V3M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
    reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    spark: '<path d="M12 3.5c.7 3.9 2.6 5.8 6.5 6.5-3.9.7-5.8 2.6-6.5 6.5-.7-3.9-2.6-5.8-6.5-6.5 3.9-.7 5.8-2.6 6.5-6.5Z"/><path d="M19 15.5v4M17 17.5h4"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    route: '<circle cx="6" cy="19" r="2.5"/><path d="M8.5 19H17a3.5 3.5 0 0 0 0-7H7a3.5 3.5 0 0 1 0-7h8.5"/><circle cx="18" cy="5" r="2.5"/>',
    orbit: '<circle cx="12" cy="12" r="2.5"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-20 12 12)"/>',
    gate: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/>',
    skip: '<path d="M19 20 9 12l10-8v16ZM5 19V5"/>',
    upload: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    bolt: '<path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2Z"/>',
    layers: '<path d="m12 2 9.5 5L12 12 2.5 7 12 2Z"/><path d="m2.5 12 9.5 5 9.5-5M2.5 17l9.5 5 9.5-5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    camera: '<path d="M4 8h3l1.6-2.4A1.5 1.5 0 0 1 9.9 5h4.2a1.5 1.5 0 0 1 1.3.6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    wide: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.5"/>',
    tall: '<rect x="7" y="2.5" width="10" height="19" rx="1.5"/>',
    square: '<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/>',
};

export type IconName = keyof typeof paths;

export function icon(name: IconName, size = 16): string {
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

/** The mark: a spark inside an orbit, on an ember tile (the playground's, until Wexy has its own). */
export function logo(size = 26): string {
    const id = `logo${Math.random().toString(36).slice(2, 7)}`;
    return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a4d"/><stop offset="0.55" stop-color="#ff5a3d"/><stop offset="1" stop-color="#d93a7a"/></linearGradient></defs>
<rect width="32" height="32" rx="9" fill="url(#${id})"/>
<ellipse cx="16" cy="16.5" rx="11.5" ry="4.6" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.3" transform="rotate(-18 16 16.5)"/>
<path d="M16 6.2c.85 4.4 3.2 6.75 7.6 7.6-4.4.85-6.75 3.2-7.6 7.6-.85-4.4-3.2-6.75-7.6-7.6 4.4-.85 6.75-3.2 7.6-7.6Z" fill="#fff"/>
</svg>`;
}
