/**
 * Image format sniffing shared by the agents that move images between the app
 * and a model: MIME type from magic bytes, file extension, and pixel size from
 * the header (no decoding).
 */

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * The image type of `bytes` from its magic header, or null for anything else.
 * Wire-supplied MIME types are unreliable (the iOS picker reports "image/heic"
 * or nothing), and model APIs accept only these four.
 */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

export function extensionForImageMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        case 'image/png':
        default:
            return 'png';
    }
}

/** Pixel size read from the image header, or null when it cannot be found. */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
    const size = readHeaderSize(bytes);
    return size && size.width > 0 && size.height > 0 ? size : null;
}

function readHeaderSize(bytes: Uint8Array): { width: number; height: number } | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (detectImageMime(bytes)) {
        case 'image/png':
            // IHDR is always the first chunk: width/height at 16/20, big-endian.
            return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
        case 'image/gif':
            return bytes.length >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : null;
        case 'image/jpeg':
            return readJpegSize(bytes, view);
        case 'image/webp':
            return readWebpSize(bytes, view);
        default:
            return null;
    }
}

function readJpegSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xFF) {
            offset++;
            continue;
        }
        const marker = bytes[offset + 1];
        // Fill bytes and standalone markers carry no length.
        if (marker === 0xFF || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) {
            offset += marker === 0xFF ? 1 : 2;
            continue;
        }
        // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC) hold the frame size.
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        offset += 2 + view.getUint16(offset + 2);
    }
    return null;
}

function readWebpSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
    if (bytes.length < 30) return null;
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    switch (chunk) {
        case 'VP8 ':
            return { width: view.getUint16(26, true) & 0x3FFF, height: view.getUint16(28, true) & 0x3FFF };
        case 'VP8L': {
            const bits = view.getUint32(21, true);
            return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
        }
        case 'VP8X':
            return {
                width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
                height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
            };
        default:
            return null;
    }
}
