import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mp3 } from './helpers.mjs';

test('drafts and their media remain private; publish exposes only safe metadata; unpublish revokes future media requests', async t => {
  const f = await fixture(t); let p = await f.complete();
  assert.deepEqual((await (await f.call('/api/projects',{mode:'public'})).json()).projects,[]);
  assert.equal((await f.call(p.audioUrl,{mode:'public'})).status,404);
  assert.equal((await f.call(p.artworkUrl,{mode:'public'})).status,404);
  p = await (await f.update(p,{published:true})).json();
  const data = (await (await f.call('/api/projects',{mode:'public'})).json()).projects;
  assert.equal(data.length,1); assert.equal(data[0].title,p.title); assert.equal('revision' in data[0],false); assert.equal('object_key' in data[0],false);
  const audio = await f.call(p.audioUrl,{mode:'public'}); assert.equal(audio.status,200); assert.equal(audio.headers.get('Content-Type'),'audio/mpeg'); assert.equal(audio.headers.get('Cache-Control'),'no-store'); assert.equal(audio.headers.get('X-Content-Type-Options'),'nosniff');
  p = await (await f.update(p,{published:false})).json(); assert.equal((await f.call(p.audioUrl,{mode:'public'})).status,404);
});
test('cannot publish incomplete project; conflicting edit does not overwrite', async t => {
  const f = await fixture(t), p = await f.create();
  assert.equal((await f.update(p,{published:true})).status,400);
  assert.equal((await f.update(p,{title:'New title'})).status,200);
  assert.equal((await f.update(p,{title:'Stale title'})).status,409);
});
test('media supports ranges, suffix ranges, HEAD and invalid range responses', async t => {
  const f = await fixture(t); let p=await f.complete(); p=await (await f.update(p,{published:true})).json();
  const r=await f.call(p.audioUrl,{mode:'public',headers:{Range:'bytes=0-9'}}); assert.equal(r.status,206); assert.equal(r.headers.get('Content-Range'),'bytes 0-9/834'); assert.equal((await r.arrayBuffer()).byteLength,10);
  const head=await f.call(p.audioUrl,{mode:'public',method:'HEAD'}); assert.equal(head.status,200); assert.equal((await head.text()).length,0);
  assert.equal((await f.call(p.audioUrl,{mode:'public',headers:{Range:'bytes=9999-'}})).status,416);
});
test('replace and delete clean associated files without touching other projects', async t => {
  const f=await fixture(t); let first=await f.complete('One'); const second=await f.complete('Two'); const old=first.audioUrl;
  first=await (await f.upload(first,'audio')).json(); assert.equal((await f.call(old)).status,404); assert.equal(f.env.MEDIA.objects.size,4);
  assert.equal((await f.call('/api/admin/projects/'+first.id,{method:'DELETE',body:{revision:first.revision}})).status,200);
  assert.equal(f.env.MEDIA.objects.size,2); assert.equal((await f.call(second.audioUrl)).status,200);
  assert.equal((await f.call('/api/admin/projects/'+second.id,{method:'DELETE',body:{revision:second.revision,object_key:'anything'}})).status,400);
});
test('deletion failure is retried by scheduled cleanup and project stays hidden', async t => {
  const f=await fixture(t); let p=await f.complete(); p=await (await f.update(p,{published:true})).json(); f.env.MEDIA.failDelete=true;
  assert.equal((await f.call('/api/admin/projects/'+p.id,{method:'DELETE',body:{revision:p.revision}})).status,200);
  assert.equal((await f.call(p.audioUrl,{mode:'public'})).status,404); assert.equal(f.env.MEDIA.objects.size,2);
  f.env.MEDIA.failDelete=false; await f.worker.scheduled({},f.env,f.ctx); await Promise.all(f.pending.splice(0)); assert.equal(f.env.MEDIA.objects.size,0);
});
test('failed upload reservation is reclaimed by scheduled cleanup', async t => {
  const f=await fixture(t),p=await f.create(); f.env.MEDIA.failPut=true;
  assert.equal((await f.upload(p,'audio')).status,500); f.env.MEDIA.failPut=false;
  await f.worker.scheduled({},f.env,f.ctx); await Promise.all(f.pending.splice(0));
  assert.equal(f.env.DB.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count,0);
});
test('atomic quota reservation prevents two concurrent uploads exceeding limit', async t => {
  const f=await fixture(t); f.env.STORAGE_QUOTA_BYTES='1000'; const a=await f.create('A'),b=await f.create('B');
  const results=await Promise.all([f.upload(a,'audio',mp3(),{flush:false}),f.upload(b,'audio',mp3(),{flush:false})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]); await Promise.all(f.pending.splice(0));
  assert.equal(f.env.DB.db.prepare('SELECT SUM(byte_size) AS bytes FROM assets').get().bytes,834);
});
test('deleting during upload does not leave an untracked object', async t => {
  const f=await fixture(t),p=await f.create(); let signalStart,release;
  const started=new Promise(resolve=>{signalStart=resolve;}); const blocked=new Promise(resolve=>{release=resolve;});
  f.env.MEDIA.beforePut=async()=>{signalStart();await blocked;};
  const request=f.upload(p,'audio',mp3(),{flush:false}); await started;
  assert.equal((await f.call('/api/admin/projects/'+p.id,{method:'DELETE',body:{revision:p.revision}})).status,200);
  release(); assert.equal((await request).status,409);
  await f.worker.scheduled({},f.env,f.ctx); await Promise.all(f.pending.splice(0)); assert.equal(f.env.MEDIA.objects.size,0);
});
test('order is persisted and invalid lists are refused', async t => {
  const f=await fixture(t),a=await f.create('A'),b=await f.create('B');
  assert.equal((await f.call('/api/admin/reorder',{method:'POST',body:{ids:[b.id,a.id]}})).status,200);
  const list=(await (await f.call('/api/admin/projects')).json()).projects; assert.deepEqual(list.map(p=>p.id),[b.id,a.id]);
  assert.equal((await f.call('/api/admin/reorder',{method:'POST',body:{ids:[a.id,a.id]}})).status,400);
  assert.equal((await f.call('/api/admin/reorder',{method:'POST',body:{ids:[a.id]}})).status,409);
});
test('upload filenames and MIME headers cannot inject executable files or keys', async t => {
  const f=await fixture(t),p=await f.create();
  const bad=await f.upload(p,'audio',new TextEncoder().encode('<script>alert(1)</script>'),{headers:{'Content-Type':'audio/mpeg','X-Filename':'../evil.mp3'}}); assert.equal(bad.status,415); assert.equal(f.env.MEDIA.objects.size,0);
  assert.equal((await f.call('/media/..%2fsecret')).status,404);
});
