import { expect, test } from 'bun:test';
import { datasetCopyBytes } from '../../../src/lish/dataset-transfer.ts';
import type { ILISH } from '@shared';

test.each([2000, 4000])('counts copy space without repeatedly scanning %i files and bindings', count => {
 let pathReads = 0;
 const files = Array.from({length: count}, (_, index) => ({ get path() { pathReads++; return `file-${index}`; }, size: 0, checksums: [] }));
 const links = Array.from({length: count}, (_, index) => ({path: `copy-${index}`, target: `file-${count - 1}`}));
 const bindings = links.map(link => ({ get path() { pathReads++; return link.path; }, target: link.target, source: link.target, hardlink: false, materializedIdentity: 'local' }));
 const manifest: ILISH = {id:'many-links', created:'2026-01-01', chunkSize:4, checksumAlgo:'sha256', files, links};
 expect(datasetCopyBytes(manifest, {kind:'explicit',path:process.cwd()},bindings)).toBe(0n);
 expect(pathReads).toBeLessThan(count * 12);
});
