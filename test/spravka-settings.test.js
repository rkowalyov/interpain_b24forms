const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { defaults,validateSettings,settingsStore } = require('../lib/bitrix-spravka-settings');

test('settings validation fails closed for empty enabled lists, unknown keys and noncanonical IDs',()=>{
  for(const value of [
    {...defaults(),enabled:true},{...defaults(),allowedUserIds:['0']},
    {...defaults(),allowedUserIds:[17]},{...defaults(),allowedUserIds:['17','17']},
    {...defaults(),revision:-1},{...defaults(),revision:1.5},{...defaults(),version:2},
    {...defaults(),cacheSeconds:0},{...defaults(),password:'never-edit-password'},
    {...defaults(),allowedUserIds:Array(501).fill('1')}
  ])assert.throws(()=>validateSettings(value),e=>e.status===400);
  assert.deepEqual(validateSettings(defaults()),defaults());
});

test('private settings survive restart, compare revision atomically and bind to one installation',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spravka-policy-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=settingsStore(dir),binding='a'.repeat(64);
  assert.deepEqual(await store.read(binding),defaults());
  const initial={...defaults(),allowedUserIds:['17']};
  const saved=await store.write(binding,0,initial);assert.equal(saved.revision,1);
  assert.deepEqual(await settingsStore(dir).read(binding),saved);
  assert.equal((await fs.stat(path.join(dir,'settings.json'))).mode&0o777,0o600);
  await assert.rejects(store.write(binding,0,initial),e=>e.status===409);
  await assert.rejects(store.read('b'.repeat(64)),e=>e.status===503);
  const updates=await Promise.allSettled([store.write(binding,1,saved),store.write(binding,1,saved)]);
  assert.equal(updates.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await store.read(binding)).revision,2);
  assert.equal((await fs.readdir(dir)).filter(f=>f!== 'settings.json').length,0);
});

test('settings reject corruption, public permissions, directories and symbolic links without overwriting',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spravka-policy-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json'),store=settingsStore(dir),binding='a'.repeat(64);
  await store.write(binding,0,defaults());
  await fs.chmod(file,0o644);await assert.rejects(store.read(binding));await fs.chmod(file,0o600);
  await fs.chmod(dir,0o755);await assert.rejects(store.read(binding));await fs.chmod(dir,0o700);
  await fs.writeFile(file,'bad-json');
  await assert.rejects(store.read(binding));await assert.rejects(store.write(binding,0,defaults()));
  assert.equal(await fs.readFile(file,'utf8'),'bad-json');
  await fs.unlink(file);await fs.mkdir(file);await assert.rejects(store.read(binding));await fs.rmdir(file);
  await fs.writeFile(path.join(dir,'other'),'{}',{mode:0o600});await fs.symlink(path.join(dir,'other'),file);
  await assert.rejects(store.read(binding));
  assert.throws(()=>settingsStore(path.join(__dirname,'..','.state')));
  assert.throws(()=>settingsStore('relative'));
});
