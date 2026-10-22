import {registerHooks} from 'node:module';
import {cli} from './shutdown-native.mjs';

const target=new URL('../../dist/native.js',import.meta.url).href;
const replacement=new URL('./shutdown-native.mjs',import.meta.url).href;
registerHooks({resolve(specifier,context,next) {
  const resolved=next(specifier,context);
  return resolved.url===target?{url:replacement,shortCircuit:true}:resolved;
}});
const {Engine}=await import('../../dist/engine.js');
Engine.prototype.executable=async()=> 'test-engine';
Engine.prototype.cli=cli;
