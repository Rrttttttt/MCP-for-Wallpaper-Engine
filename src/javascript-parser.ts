import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parse as parseJavaScript, version } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';
import { relativeFile, type Files } from './files.js';

type Mode = 'script' | 'module' | 'script-or-module';
interface Source { file: string; mode: Mode; line: number; column: number; inline?: number }
interface Issue { code: string; file: string; message: string; line?: number; column?: number }
const jsTypes = new Set(['application/ecmascript','application/javascript','application/x-ecmascript','application/x-javascript',
  'text/ecmascript','text/javascript','text/javascript1.0','text/javascript1.1','text/javascript1.2','text/javascript1.3',
  'text/javascript1.4','text/javascript1.5','text/jscript','text/livescript','text/x-ecmascript','text/x-javascript']);

export function parseWebJavaScript(files: Files) {
  const checked: Source[] = [], issues: Issue[] = [], warnings: string[] = [];
  const referenced = new Set<string>(), seen = new Set<string>();
  let bytes = 0, stopped = false;
  function issue(value: Issue) {
    if (stopped) return;
    issues.push(value);
    if (issues.length >= 64) stopped = true;
  }
  function budget(file: string, size: number) {
    if (stopped) return false;
    bytes += size;
    if (size > 1024 * 1024 || bytes > 8 * 1024 * 1024 || checked.length >= 256) {
      issue({ code: 'JS_CHECK_LIMIT', file, message: 'Syntax inspection limit: 1 MiB per HTML/script, 8 MiB total parsed input and 256 script checks. Split large sources before validating.' });
      stopped = true; return false;
    }
    return true;
  }
  function check(source: Source, text: string) {
    const key = JSON.stringify(source);
    if (seen.has(key) || stopped) return;
    seen.add(key);
    if (!budget(source.file, Buffer.byteLength(text))) return;
    checked.push(source);
    try {
      if (source.mode === 'script-or-module') {
        try { parseJavaScript(text, { ecmaVersion: 'latest', sourceType: 'script' }); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          parseJavaScript(text, { ecmaVersion: 'latest', sourceType: 'module' });
        }
      } else parseJavaScript(text, { ecmaVersion: 'latest', sourceType: source.mode });
    } catch (error) {
      const e = error as Error & { loc?: { line: number; column: number } };
      issue({ code: error instanceof SyntaxError ? 'JS_SYNTAX' : 'JS_CHECK_FAILED', file: source.file,
        message: String(e.message).slice(0, 240), ...(e.loc ? { line: source.line + e.loc.line - 1,
          column: e.loc.column + (e.loc.line === 1 ? source.column : 1) } : {}) });
    }
  }
  for (const [file, data] of files) {
    if (!/\.html?$/i.test(file) || !budget(file, data.length)) continue;
    // HTML parsing handles comments, quoted '>' characters, raw script text and inert templates.
    const document = parseHtml(data.toString('utf8'), { sourceCodeLocationInfo: true });
    const nodes: DefaultTreeAdapterTypes.Node[] = [document];
    let inline = 0;
    while (nodes.length && !stopped) {
      const node = nodes.pop()!;
      if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) nodes.push(node.childNodes[i]!);
      if (!('tagName' in node) || node.tagName !== 'script' || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
      const type = (attrs.type ?? '').trim().toLowerCase();
      if (type && type !== 'module' && !jsTypes.has(type)) continue;
      if (!type && attrs.language && !jsTypes.has('text/' + attrs.language.toLowerCase())) continue;
      const mode = type === 'module' ? 'module' : 'script';
      if (attrs.src !== undefined) {
        const src = attrs.src.trim();
        if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(src)) { if (warnings.length < 32) warnings.push(`External/embedded script in ${file} was not fetched or syntax-checked.`); continue; }
        try {
          if (!src || src.startsWith('/')) throw new Error('Absolute or empty src');
          const name = relativeFile(path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURIComponent(src.split(/[?#]/)[0]!))));
          if (!/\.(?:js|mjs)$/i.test(name)) { issue({ code: 'JS_SOURCE_UNSUPPORTED', file, message: 'Local script src must use .js or .mjs for bounded syntax inspection.' }); continue; }
          const script = files.get(name);
          if (!script) { issue({ code: 'JS_SOURCE_MISSING', file, message: `Missing local script: ${name}` }); continue; }
          referenced.add(name);
          if (script.length > 1024 * 1024) { budget(name, script.length); continue; }
          check({ file: name, mode, line: 1, column: 1 }, script.toString('utf8'));
        } catch { issue({ code: 'JS_SOURCE_PATH', file, message: 'Script src must resolve to an ordinary project-relative file.' }); }
      } else {
        const location = node.sourceCodeLocation?.startTag;
        check({ file, mode, line: location?.endLine ?? 1, column: location?.endCol ?? 1, inline: ++inline },
          node.childNodes.map(child => 'value' in child ? child.value : '').join(''));
      }
    }
  }
  for (const [file, data] of files) {
    if (!/\.(?:js|mjs)$/i.test(file) || referenced.has(file) || stopped) continue;
    if (data.length > 1024 * 1024) { budget(file, data.length); continue; }
    // ponytail: unbound .js loading mode is unknown; check either grammar until module graph analysis is needed.
    check({ file, mode: /\.mjs$/i.test(file) ? 'module' : 'script-or-module', line: 1, column: 1 }, data.toString('utf8'));
  }
  return { status: issues.length ? 'failed' as const : 'passed' as const, parser: `acorn@${version}`, checked, issues, warnings,
    runtime: 'unverified' as const };
}

if (process.argv[2] === '--parse-stdin') {
  const entries: [string, string][] = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(parseWebJavaScript(new Map(entries.map(([file, base64]) => [file, Buffer.from(base64, 'base64')])))));
}
