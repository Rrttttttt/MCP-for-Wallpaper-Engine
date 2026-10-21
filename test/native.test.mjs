import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pngInfo } from '../dist/native.js';

test('capture boundary rejects malformed, zero, oversized and excessive-pixel PNG headers',()=>{
  const header = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(header);
  header.write('IHDR',12);
  header.writeUInt32BE(3840,16); header.writeUInt32BE(2160,20);
  assert.deepEqual(pngInfo(header),{width:3840,height:2160,bytes:24});
  assert.throws(()=>pngInfo(Buffer.from('not png')),e=>e.code==='INVALID_SCREENSHOT');
  header.writeUInt32BE(0,16);
  assert.throws(()=>pngInfo(header),e=>e.code==='CAPTURE_SIZE_LIMIT');
  header.writeUInt32BE(8193,16);
  assert.throws(()=>pngInfo(header),e=>e.code==='CAPTURE_SIZE_LIMIT');
  header.writeUInt32BE(7680,16); header.writeUInt32BE(4320,20);
  assert.throws(()=>pngInfo(header),e=>e.code==='CAPTURE_SIZE_LIMIT');
});
