(function () {
  'use strict';
  var canvas = document.getElementById('sky'), ctx = canvas.getContext('2d');
  var settings = { speed: 1, density: 180, audio: true, accent: '0.45 0.68 1' };
  var fps = 60, paused = false, bass = 0, mouseX = 0, mouseY = 0;
  var stars = [], seed = 431960, time = 0, last = performance.now(), accumulator = 0;
  var diagnostics = window.__weDiagnostics = { ready: false, frames: 0, audioListener: 'unavailable', audioCallbacks: 0, audioBass: 0, renderedAudioGain: 0, errors: [], settings: settings, paused: false, configuredFps: fps, elapsed: 0 };
  function record(message) { diagnostics.errors.push(String(message).slice(0,1000)); if (diagnostics.errors.length > 50) diagnostics.errors.shift(); }
  window.addEventListener('error', function (event) { record(event.message || ('Resource load failed: ' + (event.target && (event.target.src || event.target.href)))); }, true);
  window.addEventListener('unhandledrejection', function (event) { record(event.reason); });
  function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
  for (var i = 0; i < 500; i++) stars.push({ x: random(), y: random(), z: 0.2 + random() * 0.8, phase: random() * Math.PI * 2 });
  function resize() { canvas.width = Math.max(1, Math.round(innerWidth * Math.min(devicePixelRatio || 1, 2))); canvas.height = Math.max(1, Math.round(innerHeight * Math.min(devicePixelRatio || 1, 2))); }
  window.addEventListener('resize', resize); resize();
  window.addEventListener('mousemove', function (event) { mouseX = event.clientX / innerWidth - 0.5; mouseY = event.clientY / innerHeight - 0.5; });
  window.wallpaperPropertyListener = {
    applyUserProperties: function (properties) {
      Object.keys(settings).forEach(function (key) { if (properties[key]) settings[key] = properties[key].value; });
    },
    applyGeneralProperties: function (properties) {
      if (typeof properties.fps === 'number' && properties.fps >= 0) { fps = properties.fps; diagnostics.configuredFps = fps; }
    },
    setPaused: function (value) { paused = Boolean(value); diagnostics.paused = paused; last = performance.now(); accumulator = 0; }
  };
  if (typeof window.wallpaperRegisterAudioListener === 'function') {
    window.wallpaperRegisterAudioListener(function (spectrum) {
      var energy = 0;
      for (var n = 0; n < 8; n++) energy += Math.max(0, Math.min(1, Number(spectrum[n]) || 0)) + Math.max(0, Math.min(1, Number(spectrum[n + 64]) || 0));
      bass = energy / 16; diagnostics.audioBass = bass; diagnostics.audioCallbacks++;
    });
    diagnostics.audioListener = 'registered';
  }
  function draw(dt) {
    time += dt * Math.max(0, Math.min(4, Number(settings.speed) || 0));
    var w = canvas.width, h = canvas.height;
    var glow = settings.audio ? bass : 0;
    diagnostics.renderedAudioGain = glow;
    var background = ctx.createRadialGradient(w * 0.62, h * 0.38, 0, w * 0.5, h * 0.5, Math.max(w,h) * 0.8);
    background.addColorStop(0, '#10264b'); background.addColorStop(0.55, '#071326'); background.addColorStop(1, '#020611');
    ctx.fillStyle = background; ctx.fillRect(0,0,w,h);
    var color = String(settings.accent).split(' ').map(function (v) { return Math.round(Math.max(0,Math.min(1,Number(v) || 0)) * 255); }).join(',');
    var count = Math.max(20, Math.min(500, Number(settings.density) || 180));
    for (var s = 0; s < count; s++) {
      var star = stars[s], x = ((star.x + time * 0.004 * star.z - mouseX * star.z * 0.025) % 1 + 1) % 1 * w;
      var y = ((star.y + Math.sin(time * 0.06 + star.phase) * 0.004 - mouseY * star.z * 0.025) % 1 + 1) % 1 * h;
      var radius = (0.45 + star.z * 1.25 + glow * star.z * 1.5) * Math.min(w / 1920, 2);
      ctx.globalAlpha = 0.35 + (Math.sin(time * 0.4 + star.phase) * 0.5 + 0.5) * 0.65;
      ctx.fillStyle = 'rgb(' + color + ')'; ctx.beginPath(); ctx.arc(x,y,Math.max(0.35,radius),0,Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    diagnostics.frames++; diagnostics.elapsed = time; diagnostics.width = w; diagnostics.height = h;
  }
  function tick(now) {
    requestAnimationFrame(tick);
    var dt = Math.min(0.25, Math.max(0,(now-last)/1000)); last = now;
    if (paused) return;
    accumulator += dt;
    if (fps > 0 && accumulator < 1/fps) return;
    draw(accumulator); accumulator = 0;
  }
  draw(0); diagnostics.ready = true; requestAnimationFrame(tick);
}());
