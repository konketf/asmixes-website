import test from 'node:test';
import assert from 'node:assert/strict';
import { metadata, inspectFile, readLimited, validId } from '../src/validation.mjs';
import { mp3, wav, png } from './helpers.mjs';
import { parseRange } from '../src/worker.mjs';

test('metadata rejects script markup, control characters, arbitrary keys, invalid publication and excessive lengths', () => {
  for (const extra of [{ title: '<script>alert(1)</script>' }, { artist: '\u0000' }, { object_key: '../secret' }, { published: 'yes' }, { title: 'x'.repeat(121) }, { credit: 'Production' }, { revision: -1 }]) assert.throws(() => metadata({ title: 'Song', artist: 'Band', ...extra }), error => error.status === 400);
  assert.deepEqual(metadata({ title: ' Song ', artist: 'Band', description: 'A & B' }), { title: 'Song', artist: 'Band', description: 'A & B', credit: 'Mixing + mastering', published: false, revision: undefined });
});
test('actual content determines accepted MP3, WAV and PNG type', () => {
  assert.equal(inspectFile(mp3(), 'audio').type, 'audio/mpeg');
  assert.equal(inspectFile(wav(), 'audio').type, 'audio/wav');
  assert.equal(inspectFile(png(), 'artwork').type, 'image/png');
  assert.throws(() => inspectFile(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'), 'artwork'));
  assert.throws(() => inspectFile(png(), 'audio'));
  assert.throws(() => inspectFile(new TextEncoder().encode('ID3just a fake mp3 file'), 'audio'));
});
test('rejects malformed WAV and oversized image dimensions', () => {
  const badWav = wav(); badWav[4] = 0; assert.throws(() => inspectFile(badWav, 'audio'));
  const image = png(); new DataView(image.buffer).setUint32(16, 10000); assert.throws(() => inspectFile(image, 'artwork'));
});
test('checks JPEG and WebP content signatures', () => {
  const jpg = new Uint8Array([255,216,255,192,0,8,8,0,1,0,1,1,255,217]); assert.equal(inspectFile(jpg, 'artwork').type, 'image/jpeg');
  const webp = new Uint8Array(25); webp.set(new TextEncoder().encode('RIFF')); new DataView(webp.buffer).setUint32(4,17,true); webp.set(new TextEncoder().encode('WEBPVP8L'),8); webp[20]=47;
  assert.equal(inspectFile(webp, 'artwork').type, 'image/webp');
});
test('bounded body reader rejects dishonest lengths and chunked oversized requests', async () => {
  await assert.rejects(readLimited(new Request('https://example.com', { method: 'POST', body: new Uint8Array(20) }), 10), error => error.status === 413);
  await assert.rejects(readLimited(new Request('https://example.com', { method: 'POST', headers: { 'Content-Length': '999' }, body: 'small' }), 10), error => error.status === 413);
});
test('range parser supports browser seek requests and rejects invalid or multipart ranges', () => {
  assert.deepEqual(parseRange('bytes=10-19',100),{offset:10,length:10});
  assert.deepEqual(parseRange('bytes=-10',100),{offset:90,length:10});
  assert.deepEqual(parseRange('bytes=90-',100),{offset:90,length:10});
  for (const value of ['bytes=100-','bytes=2-1','bytes=0-1,3-4','bytes=-0']) assert.throws(() => parseRange(value,100));
  assert.equal(validId('../secret'),false); assert.equal(validId('projects/key.mp3'),false);
});
