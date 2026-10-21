// Bounded 8-bit RGB/RGBA decoder for the engine acceptance scripts, not arbitrary PNG tooling.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { pngInfo } from '../dist/native.js';
export function decodePng(png) {
  const {width,height}=pngInfo(png);
  assert.equal(png[24],8); assert.ok([2,6].includes(png[25])); assert.equal(png[28],0);
  const channels=png[25]===6?4:3,stride=width*channels,compressed=[];
  for(let offset=8;offset+12<=png.length;) {
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);
    assert.ok(offset+12+length<=png.length);
    if(type==='IDAT') compressed.push(png.subarray(offset+8,offset+8+length));
    offset+=12+length;
  }
  const raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:(stride+1)*height});
  assert.equal(raw.length,(stride+1)*height);
  const pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++) {
    const filter=raw[y*(stride+1)],row=pixels.subarray(y*stride,(y+1)*stride);
    raw.copy(row,0,y*(stride+1)+1,(y+1)*(stride+1));
    const previous=y?pixels.subarray((y-1)*stride,y*stride):Buffer.alloc(stride);
    assert.ok(filter<=4);
    for(let i=0;i<stride;i++) {
      const left=i>=channels?row[i-channels]:0,up=previous[i],corner=i>=channels?previous[i-channels]:0;
      const estimate=left+up-corner,a=Math.abs(estimate-left),b=Math.abs(estimate-up),c=Math.abs(estimate-corner);
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):a<=b&&a<=c?left:b<=c?up:corner;
      row[i]=(row[i]+predictor)&255;
    }
  }
  return {width,height,channels,pixels};
}
