#!/usr/bin/env node

import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ID = 'serial-debugger';
const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(toolDir, 'ui');
const entry = path.join(sourceDir, 'main.js');
const staticFiles = ['index.html', 'styles.css', 'light.css', 'dark.css'];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;

    const eqIndex = arg.indexOf('=');
    const key = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    let value = eqIndex >= 0 ? arg.slice(eqIndex + 1) : true;
    if (eqIndex < 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1];
      index += 1;
    }
    options[key] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const outdir = path.resolve(
  toolDir,
  options.outdir || (
    options.outfile
      ? path.dirname(options.outfile)
      : path.join('dist', TOOL_ID, 'ui')
  )
);
const outfile = path.resolve(
  toolDir,
  options.outfile || path.join(outdir, 'app.js')
);

const sveltePlugin = {
  name: 'svelte',
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.svelte$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      const compiled = compile(source, {
        filename: args.path,
        generate: 'client',
        dev: false
      });

      return {
        contents: compiled.js.code,
        loader: 'js',
        warnings: compiled.warnings.map(warning => ({
          text: warning.message,
          location: warning.start ? {
            file: args.path,
            line: warning.start.line,
            column: warning.start.column
          } : undefined
        }))
      };
    });
  }
};

await mkdir(outdir, { recursive: true });
await Promise.all(staticFiles.map(fileName => copyFile(
  path.join(sourceDir, fileName),
  path.join(outdir, fileName)
)));

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100', 'edge100', 'firefox100'],
  plugins: [sveltePlugin],
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  logLevel: 'info'
});
