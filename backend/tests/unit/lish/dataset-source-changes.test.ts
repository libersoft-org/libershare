import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveDatasetData } from '../../../src/lish/dataset-transfer.ts';
import type { ILISH } from '@shared';

test.each(['append', 'same-size'])('retains a source changed after commit, before cleanup: %s', async change => {
 const base=await mkdtemp(join(tmpdir(),'lish-source-change-'));
 const source=join(base,'source'); await mkdir(source); const path=join(source,'data.bin'); await writeFile(path,'abcd');
 const manifest: ILISH={id:'source-change',created:'2026-01-01',chunkSize:4,checksumAlgo:'sha256',files:[{path:'data.bin',size:4,checksums:[new Bun.CryptoHasher('sha256').update('abcd').digest('hex')]}]};
 try {
  const result=await moveDatasetData(manifest,{kind:'derived',base,component:'source'},{kind:'derived',base,component:'target'},()=>{
   if(change==='append') appendFileSync(path,'-NEW-DATA'); else writeFileSync(path,'WXYZ');
  },()=>{});
  expect(await readFile(path,'utf8')).toBe(change==='append'?'abcd-NEW-DATA':'WXYZ');
  expect(await readFile(join(base,'target/data.bin'),'utf8')).toBe('abcd');
  expect(result.cleanupWarnings.length).toBeGreaterThan(0);
 } finally {await rm(base,{recursive:true,force:true});}
});

test.each(['chunk', 'file'])('rejects an append at the %s progress boundary before committing', async boundary=>{
 const base=await mkdtemp(join(tmpdir(),'lish-source-append-')); const source=join(base,'source'); await mkdir(source);
 const path=join(source,'data.bin'); await writeFile(path,'abcdefgh');
 const manifest: ILISH={id:'source-append',created:'2026-01-01',chunkSize:4,checksumAlgo:'sha256',files:[{path:'data.bin',size:8,checksums: ['abcd','efgh'].map(v=>new Bun.CryptoHasher('sha256').update(v).digest('hex'))}]};
 let committed=false, changed=false;
 try {
  await expect(moveDatasetData(manifest,{kind:'derived',base,component:'source'},{kind:'derived',base,component:'target'},()=>{committed=true;},event=>{
   if(event.type===boundary&&!changed){changed=true;appendFileSync(path,'-NEW');}
  })).rejects.toMatchObject({code:'FS_FILE_CHANGED'});
  expect(committed).toBe(false);
  expect(await readFile(path,'utf8')).toBe('abcdefgh-NEW');
 } finally {await rm(base,{recursive:true,force:true});}
});


test.skipIf(process.platform !== 'win32')('keeps the source when another Windows writer still holds it open', async()=>{
 const base=await mkdtemp(join(tmpdir(),'lish-open-writer-')); const source=join(base,'source'); await mkdir(source);
 const path=join(source,'data.bin'); await writeFile(path,'abcd');
 const writer=await open(path,'r+');
 const manifest: ILISH={id:'open-writer',created:'2026-01-01',chunkSize:4,checksumAlgo:'sha256',files:[{path:'data.bin',size:4,checksums:[new Bun.CryptoHasher('sha256').update('abcd').digest('hex')]}]};
 try {
  const result=await moveDatasetData(manifest,{kind:'derived',base,component:'source'},{kind:'derived',base,component:'target'},()=>{},()=>{});
  expect(result.cleanupWarnings.some(warning=>warning.stage==='source-cleanup')).toBe(true);
  await writer.write(Buffer.from('NEW'),0,3,4);
  expect(await readFile(path,'utf8')).toBe('abcdNEW');
  expect(await readFile(join(base,'target/data.bin'),'utf8')).toBe('abcd');
 } finally {await writer.close(); await rm(base,{recursive:true,force:true});}
});
