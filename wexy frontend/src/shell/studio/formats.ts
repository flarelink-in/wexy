// Video shapes and sizes, named the way people choose them: by where the video is going.

import type { IconName } from '../../shared/icons';

export type FormatId = 'wide' | 'tall' | 'square';
export type QualityId = 'hd' | 'fhd' | 'uhd';

export interface Format {
    id: FormatId;
    label: string;
    ratio: string;
    /** Width / height. */
    aspect: number;
    icon: IconName;
    where: string;
}

export const FORMATS: Format[] = [
    { id: 'wide', label: 'Wide', ratio: '16:9', aspect: 16 / 9, icon: 'wide', where: 'YouTube, slides, TV' },
    { id: 'tall', label: 'Vertical', ratio: '9:16', aspect: 9 / 16, icon: 'tall', where: 'Reels, Shorts, TikTok' },
    { id: 'square', label: 'Square', ratio: '1:1', aspect: 1, icon: 'square', where: 'Instagram, chats' },
];

export const QUALITIES: Array<{ id: QualityId; label: string; lines: number }> = [
    { id: 'hd', label: 'HD', lines: 720 },
    { id: 'fhd', label: 'Full HD', lines: 1080 },
    { id: 'uhd', label: '4K', lines: 2160 },
];

export function formatById(id: FormatId): Format {
    return FORMATS.find(f => f.id === id) ?? FORMATS[0];
}

/** Pixel size of a frame: the short side is the quality's line count (720, 1080 or 2160). */
export function frameSize(format: FormatId, quality: QualityId): { width: number; height: number } {
    const short = (QUALITIES.find(q => q.id === quality) ?? QUALITIES[1]).lines;
    const long = Math.round((short * 16) / 9);
    if (format === 'wide') return { width: long, height: short };
    if (format === 'tall') return { width: short, height: long };
    return { width: short, height: short };
}
