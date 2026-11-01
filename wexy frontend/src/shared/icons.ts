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

// The brand, from public/icon.svg and public/icon_full.svg (the off-white #f8f7f2 on #060606).
// Both draw in currentColor, so they follow the text colour.
const MARK = "<path d=\"M269.842 235.192L416.38 381.73V405.46L553.846 542.926C589.85 504.166 609.9 453.246 609.985 400.344C610.071 347.441 590.187 296.456 554.309 257.58C518.43 218.703 469.201 194.801 416.462 190.65C363.723 186.499 311.36 202.407 269.842 235.192Z\"/><path d=\"M246.154 257.074L383.62 394.54V418.27L530.158 564.808C488.64 597.593 436.277 613.501 383.538 609.35C330.799 605.199 281.569 581.297 245.691 542.42C209.812 503.544 189.929 452.559 190.014 399.656C190.1 346.754 210.15 295.834 246.154 257.074Z\"/>";
const LOCKUP = "<path d=\"M372.822 313.672L449.58 390.43V402.86L521.586 474.866C540.446 454.563 550.948 427.891 550.993 400.18C551.038 372.469 540.622 345.763 521.829 325.399C503.035 305.035 477.248 292.515 449.623 290.341C421.998 288.166 394.57 296.499 372.822 313.672Z\"/><path d=\"M360.414 325.134L432.42 397.14V409.57L509.178 486.328C487.431 503.501 460.003 511.834 432.377 509.66C404.752 507.485 378.965 494.965 360.172 474.601C341.378 454.237 330.963 427.531 331.008 399.82C331.053 372.109 341.555 345.437 360.414 325.134Z\"/><path d=\"M618.85 450L611.5 372.75H633.4L638.5 431.4L661.75 420.9V372.75H683.5V421.05L706.75 431.4L711.85 372.75H733.75L726.4 450H705.85L672.55 435.3L639.4 450H618.85ZM786.1 450.75C772.7 450.75 762.25 447.45 754.75 440.85C747.25 434.15 743.5 424.35 743.5 411.45C743.5 398.45 747.25 388.65 754.75 382.05C762.25 375.35 772.7 372 786.1 372H823.6C832.4 372 839.1 374.1 843.7 378.3C848.4 382.4 850.75 388.3 850.75 396C850.75 411.7 841.7 419.55 823.6 419.55H766.9C769 428.85 775.4 433.5 786.1 433.5H846.85V450.75H786.1ZM786.1 389.25C775.8 389.25 769.45 393.6 767.05 402.3H822.55C824.55 402.3 826.1 401.7 827.2 400.5C828.4 399.3 829 397.65 829 395.55C829 391.35 826.85 389.25 822.55 389.25H786.1ZM852.982 450L882.082 411.45L852.982 372.9H878.482L900.832 402.75H911.782L934.282 372.9H959.632L930.682 411.45L959.632 450H934.282L911.632 420H900.832L878.482 450H852.982ZM986.849 483.75V466.5H1032.15C1038.15 466.5 1041.15 463.45 1041.15 457.35V450H994.799C985.999 450 979.549 447.8 975.449 443.4C971.449 439 969.449 433.3 969.449 426.3V372.75H991.199V423.75C991.199 429.75 994.199 432.75 1000.2 432.75H1040.4V372.75H1062.9V460.05C1062.9 467.15 1060.85 472.85 1056.75 477.15C1052.65 481.55 1046.25 483.75 1037.55 483.75H986.849ZM1080.21 450V428.55H1104.21V450H1080.21ZM1142.34 450C1134.24 450 1128.04 447.95 1123.74 443.85C1119.44 439.75 1117.29 433.9 1117.29 426.3C1117.29 418.8 1119.44 413 1123.74 408.9C1128.04 404.8 1134.24 402.75 1142.34 402.75H1199.94V399.15C1199.94 393.05 1196.94 390 1190.94 390H1127.34V372.75H1196.64C1205.74 372.75 1212.19 374.85 1215.99 379.05C1219.79 383.15 1221.69 388.95 1221.69 396.45V450H1142.34ZM1146.24 432.75H1199.94V420H1146.24C1144.34 420 1142.84 420.6 1141.74 421.8C1140.74 422.9 1140.24 424.4 1140.24 426.3C1140.24 428.2 1140.74 429.75 1141.74 430.95C1142.84 432.15 1144.34 432.75 1146.24 432.75ZM1238.25 450V372.75H1260V450H1238.25ZM1238.1 360V343.05H1260.15V360H1238.1Z\"/>";

/** The mark: two halves of a circle, offset along a diagonal cut. */
export function logo(size = 26): string {
    return `<svg class="logo" width="${size}" height="${size}" viewBox="190 190 420 420" fill="currentColor" aria-hidden="true">${MARK}</svg>`;
}

/** The mark and the wordmark "wexy.ai", as one lockup, `height` pixels tall. */
export function wordmark(height = 24): string {
    const width = Math.round((height * 938) / 220);
    return `<svg class="wordmark" width="${width}" height="${height}" viewBox="331 290 938 220" fill="currentColor" aria-hidden="true">${LOCKUP}</svg>`;
}

/** One of the brand loaders in public/ (loader1 to loader3: the mark turning, parting, shading). Still under
 *  prefers-reduced-motion: the first frame is the mark at rest. */
export function loader(n: 1 | 2 | 3 = 1, size = 64): string {
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    return `<video class="loader" src="/loader${n}.mp4" width="${size}" height="${size}" muted playsinline loop preload="auto" ${still ? '' : 'autoplay '}aria-hidden="true" tabindex="-1" disablepictureinpicture></video>`;
}
