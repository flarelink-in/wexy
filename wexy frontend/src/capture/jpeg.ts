// A review frame as JPEG (EA6.1; visual-review-design.md §6): opaque RGBA, already fitted into 768 × 432 by the host
// (exec/review-capture.ts), put on an OffscreenCanvas and encoded by the browser at the quality the capture asks for.
// Quality 0.85 is where it starts, not a promise of a size: the capture holds every frame to its byte cap and lowers the
// quality at most twice. Browser only; the tests encode with a fake.

export async function encodeJpeg(rgba: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array> {
    if (rgba.length !== width * height * 4) throw new Error(`a ${width}×${height} frame is ${width * height * 4} bytes of RGBA, not ${rgba.length}`);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser gives no 2D canvas to encode a JPEG with');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
}
