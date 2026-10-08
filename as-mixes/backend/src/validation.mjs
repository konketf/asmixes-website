import { HttpError } from './auth.mjs';

export const AUDIO_LIMIT = 30 * 1024 * 1024;
export const ARTWORK_LIMIT = 5 * 1024 * 1024;
export const PROJECT_LIMIT = 100;
export function validId(value) { return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value); }

export function metadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid project details.');
  const allowed = ['title', 'artist', 'description', 'credit', 'published', 'revision'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown project field.');
  const text = (name, limit, required) => {
    const value = input[name] ?? '';
    if (typeof value !== 'string') throw new HttpError(400, `Invalid ${name}.`);
    const cleaned = value.trim().normalize('NFC');
    if ((required && !cleaned) || cleaned.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/.test(cleaned)) {
      throw new HttpError(400, `Check the ${name} field.`);
    }
    return cleaned;
  };
  const credit = input.credit ?? 'Mixing + mastering';
  if (!['Mixing', 'Mastering', 'Mixing + mastering'].includes(credit)) throw new HttpError(400, 'Invalid credit.');
  if (input.published !== undefined && typeof input.published !== 'boolean') throw new HttpError(400, 'Invalid publish status.');
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new HttpError(400, 'Invalid revision.');
  return { title: text('title', 120, true), artist: text('artist', 120, true), description: text('description', 1000, false), credit, published: input.published ?? false, revision: input.revision };
}

export async function readLimited(request, limit) {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, 'File or request is too large.');
  if (!request.body) throw new HttpError(400, 'Empty request.');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new HttpError(413, 'File or request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!length) throw new HttpError(400, 'Empty request.');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Expected JSON.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readLimited(request, 8192))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON.'); }
}

const ascii = (b, start, length) => String.fromCharCode(...b.subarray(start, start + length));
export function inspectFile(bytes, kind) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) throw new HttpError(415, 'Invalid file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 'audio') {
    if (bytes.length > AUDIO_LIMIT) throw new HttpError(413, 'Audio must be at most 30 MiB.');
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
      if (view.getUint32(4, true) + 8 !== bytes.length) throw new HttpError(415, 'Invalid WAV length.');
      let format = false, data = false;
      for (let at = 12; at + 8 <= bytes.length;) {
        const tag = ascii(bytes, at, 4), size = view.getUint32(at + 4, true);
        if (at + 8 + size > bytes.length) throw new HttpError(415, 'Invalid WAV chunk.');
        if (tag === 'fmt ') {
          if (size < 16 || ![1, 3, 65534].includes(view.getUint16(at + 8, true)) || view.getUint16(at + 10, true) < 1 || view.getUint16(at + 10, true) > 8 || !view.getUint32(at + 12, true)) throw new HttpError(415, 'Unsupported WAV format.');
          format = true;
        }
        if (tag === 'data' && size > 0) data = true;
        at += 8 + size + (size % 2);
      }
      if (format && data) return { type: 'audio/wav', extension: 'wav' };
      throw new HttpError(415, 'WAV must contain audio data.');
    }
    // Skip a bounded ID3v2 tag, then check two consecutive MPEG Layer III frames.
    let start = 0;
    if (ascii(bytes, 0, 3) === 'ID3') {
      if (![2, 3, 4].includes(bytes[3]) || bytes.subarray(6, 10).some(n => n > 127)) throw new HttpError(415, 'Invalid MP3 tag.');
      start = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + ((bytes[3] === 4 && (bytes[5] & 16)) ? 10 : 0);
    }
    const frame = at => {
      if (at + 4 > bytes.length || bytes[at] !== 255 || (bytes[at + 1] & 224) !== 224) return 0;
      const version = (bytes[at + 1] >> 3) & 3, layer = (bytes[at + 1] >> 1) & 3;
      const bit = bytes[at + 2] >> 4, sample = (bytes[at + 2] >> 2) & 3;
      if (version === 1 || layer !== 1 || bit === 0 || bit === 15 || sample === 3) return 0;
      const rates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
      const hz = [44100,48000,32000][sample] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      return Math.floor((version === 3 ? 144000 : 72000) * rates[bit] / hz) + ((bytes[at + 2] >> 1) & 1);
    };
    const first = frame(start), second = first && frame(start + first);
    if (first && second && start + first + second <= bytes.length) return { type: 'audio/mpeg', extension: 'mp3' };
  } else if (kind === 'artwork') {
    if (bytes.length > ARTWORK_LIMIT) throw new HttpError(413, 'Artwork must be at most 5 MiB.');
    const dimensions = (width, height) => { if (!width || !height || width > 6000 || height > 6000 || width * height > 20000000) throw new HttpError(415, 'Artwork dimensions are too large or invalid.'); };
    if (bytes.length >= 33 && bytes.subarray(0, 8).every((n, i) => n === [137,80,78,71,13,10,26,10][i]) && ascii(bytes, 12, 4) === 'IHDR' && view.getUint32(8) === 13) {
      dimensions(view.getUint32(16), view.getUint32(20));
      if (ascii(bytes, bytes.length - 8, 4) !== 'IEND') throw new HttpError(415, 'Invalid PNG.');
      return { type: 'image/png', extension: 'png' };
    }
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
      let found = false;
      for (let at = 2; at + 4 < bytes.length;) {
        if (bytes[at] !== 255) break;
        while (bytes[at] === 255) at++;
        const marker = bytes[at++];
        if (marker === 218 || marker === 217) break;
        const size = view.getUint16(at);
        if (size < 2 || at + size > bytes.length) break;
        if ([192,193,194].includes(marker) && size >= 8) { dimensions(view.getUint16(at + 5), view.getUint16(at + 3)); found = true; }
        at += size;
      }
      if (found) return { type: 'image/jpeg', extension: 'jpg' };
    }
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && view.getUint32(4, true) + 8 === bytes.length) {
      const tag = ascii(bytes, 12, 4);
      if (tag === 'VP8X' && bytes.length >= 30) {
        if (bytes[20] & 2) throw new HttpError(415, 'Use non-animated artwork.');
        dimensions(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
      } else if (tag === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
        dimensions(view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383);
      } else if (tag === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) {
        dimensions(1 + bytes[21] + ((bytes[22] & 63) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10));
      } else throw new HttpError(415, 'Invalid WebP.');
      return { type: 'image/webp', extension: 'webp' };
    }
  }
  throw new HttpError(415, 'Use a valid MP3 or WAV for audio, or JPEG, PNG, or WebP for artwork.');
}
