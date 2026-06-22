#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(toolDir, 'ui');
const publicFontsDir = path.join(uiDir, 'public', 'fonts', 'fontawesome6');
const cssOutDir = path.join(publicFontsDir, 'css');
const webfontsOutDir = path.join(publicFontsDir, 'webfonts');

const FONTAWESOME_SOURCE_CANDIDATES = [
  process.env.AILY_FONTAWESOME_DIR,
  path.resolve(toolDir, '..', '..', '..', 'OutSource', 'aily--blockly', 'public', 'fonts', 'fontawesome6'),
  path.resolve(toolDir, '..', '..', 'aily--blockly', 'public', 'fonts', 'fontawesome6'),
  path.resolve(toolDir, '..', '..', 'OutSource', 'aily--blockly', 'public', 'fonts', 'fontawesome6'),
].filter(Boolean);

async function resolveFontawesomeSourceDir() {
  for (const candidate of FONTAWESOME_SOURCE_CANDIDATES) {
    const cssPath = path.join(candidate, 'css', 'fontawesome.css');
    const fontPath = path.join(candidate, 'webfonts', 'fa-light-300.woff2');
    try {
      await readFile(cssPath);
      await readFile(fontPath);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    'Font Awesome Pro source was not found. Set AILY_FONTAWESOME_DIR to public/fonts/fontawesome6 from Aily Blockly.'
  );
}

function extractRuleBlock(source, className) {
  const pattern = new RegExp(`\\.${className}::before\\s*\\{[^}]+\\}`, 'g');
  const match = source.match(pattern);
  return match?.[0] || '';
}

function buildBaseCss(source) {
  const blocks = [
    extractBlock(source, /^\.fa \{/m, /^\.fa-1x \{/m),
    extractBlock(source, /^\.fa,\s/m, /^\.fa-1x \{/m),
    extractBlock(source, /^\.fas,\s/m, /^\.fa-1x \{/m),
    extractBlock(source, /^\.fa-spin \{/m, /^\.fa-spin-reverse \{/m),
    extractBlock(source, /^@media \(prefers-reduced-motion: reduce\) \{/m, /^@-webkit-keyframes fa-beat \{/m),
    extractBlock(source, /^@-webkit-keyframes fa-spin \{/m, /^\.fa-rotate-90 \{/m),
    extractBlock(source, /^@keyframes fa-spin \{/m, /^\.fa-rotate-90 \{/m),
  ].filter(Boolean);

  return `${blocks.join('\n\n')}\n`;
}

function extractBlock(source, startPattern, endPattern) {
  const start = source.search(startPattern);
  if (start < 0) return '';

  const end = source.slice(start + 1).search(endPattern);
  if (end < 0) return source.slice(start).trim();

  return source.slice(start, start + 1 + end).trim();
}

async function readRegisteredIcons() {
  const registrySource = await readFile(path.join(uiDir, 'src', 'icons', 'registry.ts'), 'utf8');
  const match = registrySource.match(/export const FA_LIGHT_ICONS = \[([\s\S]*?)\] as const;/);
  if (!match) {
    throw new Error('Could not parse FA_LIGHT_ICONS from ui/src/icons/registry.ts');
  }

  return [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map(entry => entry[1]);
}

async function main() {
  const sourceDir = await resolveFontawesomeSourceDir();
  const sourceCss = await readFile(path.join(sourceDir, 'css', 'fontawesome.css'), 'utf8');
  const lightCss = await readFile(path.join(sourceDir, 'css', 'light.min.css'), 'utf8');
  const FA_LIGHT_ICONS = await readRegisteredIcons();

  const iconRules = FA_LIGHT_ICONS
    .map(iconName => extractRuleBlock(sourceCss, `fa-${iconName}`))
    .filter(Boolean);

  const missing = FA_LIGHT_ICONS.filter(iconName => !extractRuleBlock(sourceCss, `fa-${iconName}`));
  if (missing.length) {
    throw new Error(`Missing Font Awesome icon rules: ${missing.join(', ')}`);
  }

  await mkdir(cssOutDir, { recursive: true });
  await mkdir(webfontsOutDir, { recursive: true });

  const subsetCss = [
    '/*! Aily Chat Font Awesome Pro Light subset */',
    lightCss.trim(),
    buildBaseCss(sourceCss),
    iconRules.join('\n'),
  ].join('\n\n');

  await writeFile(path.join(cssOutDir, 'aily-chat-icons.css'), `${subsetCss}\n`, 'utf8');
  await cp(
    path.join(sourceDir, 'webfonts', 'fa-light-300.woff2'),
    path.join(webfontsOutDir, 'fa-light-300.woff2')
  );

  console.log(`Font Awesome subset built (${FA_LIGHT_ICONS.length} icons) -> ui/public/fonts/fontawesome6`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
