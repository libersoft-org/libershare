import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveDatasetData } from '../../../src/lish/dataset-transfer.ts';
import { SafeDataset } from '../../../src/lish/safe-dataset-files.ts';
import type { ILISH } from '@shared';
const scratch: string[] = [];
afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, {recursive:true,force:true}); });
async function fixture() {
 const base=await mkdtemp(join(tmpdir(),'lish-existing-target-')); scratch.push(base);
 const source=join(base,'source'), target=join(base,'target');
 await mkdir(source); await mkdir(target); await writeFile(join(source,'data.bin'),'data');
 const manifest: ILISH={id:'existing-target',created:'2026-01-01',chunkSize:4,checksumAlgo:'sha256',files:[{path:'data.bin',size:4,checksums:[new Bun.CryptoHasher('sha256').update('data').digest('hex')]}]};
 let committed=false;
 return {source,target,manifest,move:()=>moveDatasetData(manifest,{kind:'explicit',path:source},{kind:'explicit',path:target},()=>{committed=true;},()=>{}),committed:()=>committed};
}
test('moves into an explicitly selected empty directory without replacing it', async()=>{
 const f=await fixture(); const identity=(await stat(f.target,{bigint:true})).ino;
 await f.move();
 expect(f.committed()).toBe(true);
 expect((await stat(f.target,{bigint:true})).ino).toBe(identity);
 expect(await readFile(join(f.target,'data.bin'),'utf8')).toBe('data');
});
test('refuses a selected nonempty directory without changing its contents', async()=>{
 const f=await fixture(); await writeFile(join(f.target,'other.bin'),'keep');
 await expect(f.move()).rejects.toMatchObject({code:'EEXIST'});
 expect(f.committed()).toBe(false);
 expect(await readdir(f.target)).toEqual(['other.bin']);
 expect(await readFile(join(f.source,'data.bin'),'utf8')).toBe('data');
});
test('a file appearing after the empty check is not opened for writing or removed', async()=>{
 const f=await fixture();
 const prepare=SafeDataset.prototype.prepare;
 let inserted=false;
 const spy=spyOn(SafeDataset.prototype,'prepare').mockImplementation(async function(this: SafeDataset,manifest,options){
  if(options?.reserve && !inserted){ inserted=true; await writeFile(join(f.target,'data.bin'),'foreign'); }
  return prepare.call(this,manifest,options);
 });
 try {
  await expect(f.move()).rejects.toMatchObject({code:'EEXIST'});
  expect(inserted).toBe(true);
  expect(f.committed()).toBe(false);
  expect(await readFile(join(f.target,'data.bin'),'utf8')).toBe('foreign');
  expect(await readFile(join(f.source,'data.bin'),'utf8')).toBe('data');
 } finally {spy.mockRestore();}
});
test('copy failure rolls back only new files and leaves the selected directory', async()=>{
 const f=await fixture(); f.manifest.files![0]!.checksums=['0'.repeat(64)];
 const identity=(await stat(f.target,{bigint:true})).ino;
 await expect(f.move()).rejects.toMatchObject({code:'LISH_INVALID_MANIFEST'});
 expect(f.committed()).toBe(false);
 expect((await stat(f.target,{bigint:true})).ino).toBe(identity);
 expect(await readdir(f.target)).toEqual([]);
 expect(await readFile(join(f.source,'data.bin'),'utf8')).toBe('data');
});


test('does not remove an empty source selected as its own destination', async () => {
 const f = await fixture();
 await rm(join(f.source, 'data.bin'));
 f.manifest.files = [];
 let committed = false;
 await expect(moveDatasetData(f.manifest, {kind:'derived', base:join(f.source,'..'), component:'source'}, {kind:'explicit',path:f.source},()=>{committed=true;},()=>{})).rejects.toMatchObject({code:'EEXIST'});
 expect(committed).toBe(false);
 expect((await stat(f.source)).isDirectory()).toBe(true);
});
