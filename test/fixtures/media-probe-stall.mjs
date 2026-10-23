// Test-only preload replaces exactly the media parser child with a stoppable stalled worker.
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const self = fileURLToPath(import.meta.url);
if (process.argv[1] === self) {
  writeFileSync(process.env.WE_TEST_MEDIA_PID, String(process.pid));
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  const cp = createRequire(import.meta.url)('node:child_process'), original = cp.execFile;
  cp.execFile = function(command, args, options, callback) {
    if (Array.isArray(args) && args.some(arg => typeof arg === 'string' && /[\\/]media-probe\.js$/.test(arg))) {
      args = args.map(arg => /[\\/]media-probe\.js$/.test(arg) ? self : arg);
    }
    return original(command, args, options, callback);
  };
  syncBuiltinESMExports();
}
