'use strict';
// Fixed geometry and flat colors allow independent pixel measurements of this fixture.
const canvas = document.getElementById('eyes'), context = canvas.getContext('2d');
const diagnostics = window.__weDiagnostics = { ready:false,events:0,errors:[],input:null };
let pointer = { x:0,y:0 };
function draw() {
  canvas.width = innerWidth; canvas.height = innerHeight;
  const w = canvas.width,h = canvas.height,rx = w*0.12,ry = h*0.12;
  const limit = Math.max(1,Math.hypot(pointer.x,pointer.y));
  const dx = pointer.x/limit*rx*0.8,dy = pointer.y/limit*ry*0.8;
  context.fillStyle = '#101828'; context.fillRect(0,0,w,h);
  for (const center of [0.32,0.68]) {
    const x = w*center,y = h/2;
    context.save();
    context.beginPath(); context.ellipse(x,y,rx,ry,0,0,Math.PI*2);
    context.fillStyle = '#f8fafc'; context.fill(); context.clip();
    context.beginPath(); context.arc(x+dx,y+dy,h*0.055,0,Math.PI*2);
    context.fillStyle = '#00c8dc'; context.fill();
    context.beginPath(); context.arc(x+dx,y+dy,h*0.02,0,Math.PI*2);
    context.fillStyle = '#050a0f'; context.fill();
    context.restore();
  }
  diagnostics.width = w; diagnostics.height = h;
  diagnostics.offset = { x:dx,y:dy }; diagnostics.ready = true;
}
window.addEventListener('mousemove',event => {
  diagnostics.events++;
  diagnostics.input = { x:event.clientX,y:event.clientY,buttons:event.buttons,trusted:event.isTrusted };
  pointer = { x:event.clientX/(innerWidth-1)*2-1,y:event.clientY/(innerHeight-1)*2-1 };
  draw();
});
window.addEventListener('resize',draw);
window.addEventListener('error',event => diagnostics.errors.push(String(event.message).slice(0,500)));
draw();
