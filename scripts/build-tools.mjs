#!/usr/bin/env node

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeTarget = 'node18';
const assetDirs = ['ui', 'i18n', 'assets', 'skill'];
const vendorFiles = [
  {
    from: ['node_modules', 'penpal', 'dist', 'penpal.min.js'],
    to: ['vendor', 'penpal.min.js']
  }
];

const builtinExternals = [
  ...builtinModules,
  ...builtinModules.map(moduleName => `node:${moduleName}`)
];

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runtimeExternalPackages = new Set([
  '@abandonware/noble',
  'serialport'
]);

const runtimeExternalPatterns = Array.from(runtimeExternalPackages)
  .flatMap(packageName => [packageName, `${packageName}/*`]);

const commonPruneDirectoryNames = new Set([
  '.github',
  '.vscode',
  '.nyc_output',
  'benchmark',
  'benchmarks',
  'coverage',
  'doc',
  'docs',
  'example',
  'examples',
  'test',
  'tests'
]);

const commonPruneFileNames = new Set([
  '.editorconfig',
  '.eslintignore',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.gitignore',
  '.npmignore',
  '.nycrc',
  '.nycrc.json',
  '.prettierrc',
  '.prettierrc.json',
  'binding.gyp',
  'codecov.yml',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig-build.json'
]);

const commonPruneFileExtensions = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.d.ts',
  '.exp',
  '.filters',
  '.gyp',
  '.h',
  '.hpp',
  '.iobj',
  '.ipdb',
  '.lib',
  '.m',
  '.map',
  '.md',
  '.mm',
  '.pdb',
  '.sln',
  '.ts',
  '.vcxproj',
  '.yaml',
  '.yml'
]);

const installOnlyPackages = [
  '@abandonware/node-addon-api',
  '@types',
  'napi-thread-safe-callback',
  'node-addon-api'
];

function toDisplayPath(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(filePath) {
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text);
}

function assertWithin(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside ${parent}: ${child}`);
  }
}

function lockPackageKey(packageName) {
  return `node_modules/${packageName}`;
}

function runtimeDependencySpec(project, packageName, requestedSpec) {
  const lockedVersion = project.lockJson?.packages?.[lockPackageKey(packageName)]?.version;
  return lockedVersion || requestedSpec;
}

function getRuntimeDependencies(project) {
  const dependencies = project.packageJson.dependencies || {};
  const runtimeDependencies = {};

  for (const [packageName, requestedSpec] of Object.entries(dependencies)) {
    if (runtimeExternalPackages.has(packageName)) {
      runtimeDependencies[packageName] = runtimeDependencySpec(project, packageName, requestedSpec);
    }
  }

  return runtimeDependencies;
}

function hasPackageScript(project, scriptName) {
  return Boolean(project.packageJson?.scripts?.[scriptName]);
}

async function runPackageScriptWithArgs(project, scriptName, args = []) {
  if (!hasPackageScript(project, scriptName)) return;

  console.log(`  running ${scriptName}`);
  await runCommand(
    npmCommand,
    ['run', scriptName, '--', ...args],
    { cwd: project.dir }
  );
}

function rewriteDistPackageJson(project) {
  const packageJson = project.packageJson;
  const runtimeDependencies = getRuntimeDependencies(project);
  const next = {
    ...packageJson,
    main: 'index.js'
  };

  if (typeof packageJson.bin === 'string') {
    next.bin = 'index.js';
  } else if (packageJson.bin && typeof packageJson.bin === 'object') {
    next.bin = Object.fromEntries(
      Object.keys(packageJson.bin).map(command => [command, 'index.js'])
    );
  }

  delete next.devDependencies;
  delete next.peerDependencies;
  delete next.optionalDependencies;

  if (Object.keys(runtimeDependencies).length) {
    next.dependencies = runtimeDependencies;
  } else {
    delete next.dependencies;
  }

  return next;
}

async function discoverProjects() {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules' || entry.name === 'scripts') continue;

    const dir = path.join(rootDir, entry.name);
    const packagePath = path.join(dir, 'package.json');
    if (!(await pathExists(packagePath))) continue;

    const packageJson = await readJson(packagePath);
    const lockPath = path.join(dir, 'package-lock.json');
    const lockJson = await pathExists(lockPath) ? await readJson(lockPath) : null;
    projects.push({
      id: entry.name,
      dir,
      packagePath,
      packageJson,
      lockJson
    });
  }

  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

function selectProjects(projects, selectors) {
  if (!selectors.length) return projects;

  const selected = [];
  const missing = [];

  for (const selector of selectors) {
    const normalized = selector.replace(/[\\/]+$/, '');
    const match = projects.find(project => (
      project.id === normalized ||
      project.packageJson.name === normalized ||
      toDisplayPath(project.dir) === normalized.replace(/\\/g, '/')
    ));

    if (match && !selected.includes(match)) {
      selected.push(match);
    } else if (!match) {
      missing.push(selector);
    }
  }

  if (missing.length) {
    throw new Error(`Unknown project selector: ${missing.join(', ')}`);
  }

  return selected;
}

function childDirBaseName(entry) {
  const childDir = String(entry?.childDir || '').replace(/\\/g, '/');
  return childDir.split('/').filter(Boolean).pop() || null;
}

function indexEntryMatchesProject(key, entry, project) {
  return (
    key === project.id ||
    entry?.id === project.id ||
    childDirBaseName(entry) === project.id
  );
}

function namespaceFromProjectId(projectId) {
  return projectId
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function createFallbackIndexEntry(project) {
  const namespace = namespaceFromProjectId(project.id);
  const dependencies = Object.keys(project.packageJson.dependencies || {});

  return {
    id: project.id,
    titleKey: `${namespace}.TITLE`,
    namespace,
    app: {
      name: `${namespace}.TITLE`,
      description: `${namespace}.DESCRIPTION`,
      icon: 'fa-light fa-puzzle-piece',
      enabled: true
    },
    childDir: `tools/${project.id}`,
    routePath: `/child-tool/${project.id}`,
    requiredDependencies: dependencies,
    installHint: `Run npm run install:${project.id} in the project root.`
  };
}

async function loadIndexTemplate() {
  const indexBackupPath = path.join(rootDir, 'index-backup.json');
  if (!(await pathExists(indexBackupPath))) return {};

  return readJson(indexBackupPath);
}

async function copyIfExists(source, destination, label, warnings) {
  if (!(await pathExists(source))) {
    warnings.push(`Missing ${label}: ${toDisplayPath(source)}`);
    return false;
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  return true;
}

async function copyDirectoryContents(sourceDir, destinationDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);

    await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await cp(source, destination, { recursive: true });
  }
}

async function emptyDirectory(dir) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    await rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function directorySize(dir) {
  if (!(await pathExists(dir))) return 0;

  let size = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += await directorySize(entryPath);
    } else if (entry.isFile()) {
      size += (await stat(entryPath)).size;
    }
  }

  return size;
}

async function removeWithin(root, target) {
  assertWithin(root, target);
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function packagePath(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split('/'));
}

async function copyPackage(sourceNodeModulesDir, destinationNodeModulesDir, packageName) {
  const source = packagePath(sourceNodeModulesDir, packageName);
  const destination = packagePath(destinationNodeModulesDir, packageName);

  if (!(await pathExists(source))) return false;

  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await cp(source, destination, { recursive: true });
  return true;
}

function packageLockEntry(project, packageName) {
  return project.lockJson?.packages?.[lockPackageKey(packageName)] || null;
}

async function readPackageDependencyNames(nodeModulesDir, packageName) {
  const packageJsonPath = path.join(packagePath(nodeModulesDir, packageName), 'package.json');
  if (!(await pathExists(packageJsonPath))) return [];

  const packageJson = await readJson(packageJsonPath);
  return [
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.optionalDependencies || {})
  ];
}

async function collectRuntimeDependencyNames(project, rootPackageNames) {
  const sourceNodeModulesDir = path.join(project.dir, 'node_modules');
  const queued = [...rootPackageNames];
  const collected = new Set();

  while (queued.length) {
    const packageName = queued.shift();
    if (!packageName || collected.has(packageName)) continue;
    collected.add(packageName);

    const lockEntry = packageLockEntry(project, packageName);
    const dependencyNames = lockEntry
      ? [
          ...Object.keys(lockEntry.dependencies || {}),
          ...Object.keys(lockEntry.optionalDependencies || {})
        ]
      : await readPackageDependencyNames(sourceNodeModulesDir, packageName);

    for (const dependencyName of dependencyNames) {
      if (!collected.has(dependencyName)) {
        queued.push(dependencyName);
      }
    }
  }

  return collected;
}

async function copyRuntimeDependenciesFromSource(project, packageDir, runtimeDependencies) {
  const sourceNodeModulesDir = path.join(project.dir, 'node_modules');
  if (!(await pathExists(sourceNodeModulesDir))) return false;

  const destinationNodeModulesDir = path.join(packageDir, 'node_modules');
  await mkdir(destinationNodeModulesDir, { recursive: true });

  const dependencyNames = await collectRuntimeDependencyNames(
    project,
    Object.keys(runtimeDependencies)
  );
  let copiedCount = 0;

  for (const packageName of dependencyNames) {
    if (await copyPackage(sourceNodeModulesDir, destinationNodeModulesDir, packageName)) {
      copiedCount += 1;
    }
  }

  if (!copiedCount) return false;

  console.log(`  copied runtime dependencies from source node_modules (${copiedCount} package${copiedCount === 1 ? '' : 's'})`);
  await minimizeRuntimeDependencies(packageDir);
  return true;
}

function isLicenseFile(fileName) {
  const lowerName = fileName.toLowerCase();
  return (
    lowerName === 'license' ||
    lowerName.startsWith('license.') ||
    lowerName === 'copying' ||
    lowerName.startsWith('copying.') ||
    lowerName === 'notice' ||
    lowerName.startsWith('notice.')
  );
}

function shouldPruneCommonFile(fileName) {
  if (isLicenseFile(fileName)) return false;

  const lowerName = fileName.toLowerCase();
  if (commonPruneFileNames.has(lowerName)) return true;
  if (lowerName.startsWith('readme')) return true;
  if (lowerName.startsWith('changelog')) return true;
  if (lowerName.startsWith('tsconfig')) return true;

  return commonPruneFileExtensions.has(path.extname(lowerName));
}

async function pruneCommonFiles(dir, root) {
  if (!(await pathExists(dir))) return;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (commonPruneDirectoryNames.has(entry.name.toLowerCase())) {
        await removeWithin(root, entryPath);
        continue;
      }

      await pruneCommonFiles(entryPath, root);
      continue;
    }

    if (entry.isFile() && shouldPruneCommonFile(entry.name)) {
      await removeWithin(root, entryPath);
    }
  }
}

function isCurrentPrebuildDir(dirName) {
  const [platform, archPart = ''] = dirName.split('-', 2);
  if (platform !== process.platform) return false;
  return archPart.split('+').includes(process.arch);
}

async function prunePrebuildDirectories(dir, root) {
  if (!(await pathExists(dir))) return;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;

    if (entry.name === 'prebuilds') {
      const prebuilds = await readdir(entryPath, { withFileTypes: true });
      for (const prebuild of prebuilds) {
        if (prebuild.isDirectory() && !isCurrentPrebuildDir(prebuild.name)) {
          await removeWithin(root, path.join(entryPath, prebuild.name));
        }
      }
      continue;
    }

    await prunePrebuildDirectories(entryPath, root);
  }
}

async function removePackagesFromNodeModulesDirs(dir, root, packageNames) {
  if (!(await pathExists(dir))) return;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;

    if (entry.name === 'node_modules') {
      for (const packageName of packageNames) {
        await removeWithin(root, packagePath(entryPath, packageName));
      }
    }

    await removePackagesFromNodeModulesDirs(entryPath, root, packageNames);
  }
}

async function removeEmptyDirectories(dir, root) {
  if (!(await pathExists(dir))) return;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeEmptyDirectories(entryPath, root);
    }
  }

  if (dir === root) return;

  const remaining = await readdir(dir);
  if (!remaining.length) {
    await removeWithin(root, dir);
  }
}

async function keepOnlyFiles(dir, root, keepNames) {
  if (!(await pathExists(dir))) return;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !keepNames.has(entry.name)) {
      await removeWithin(root, path.join(dir, entry.name));
    }
  }
}

async function pruneNoble(nodeModulesDir, root) {
  const nobleDir = packagePath(nodeModulesDir, '@abandonware/noble');
  if (!(await pathExists(nobleDir))) return;

  await removeWithin(root, path.join(nobleDir, 'assets'));
  await removeWithin(root, path.join(nobleDir, 'build', 'lib'));
  await removeWithin(root, path.join(nobleDir, 'build', 'config.gypi'));
  await removeWithin(root, path.join(nobleDir, 'lib', 'mac', 'src'));
  await removeWithin(root, path.join(nobleDir, 'lib', 'win', 'src'));
  await removeWithin(root, path.join(nobleDir, 'test.custom.js'));
  await removeWithin(root, path.join(nobleDir, 'test.js'));
  await removeWithin(root, path.join(nobleDir, 'with-bindings.js'));
  await removeWithin(root, path.join(nobleDir, 'ws-slave.js'));

  if (process.platform === 'win32') {
    for (const relativePath of [
      ['lib', 'distributed'],
      ['lib', 'hci-socket'],
      ['lib', 'mac'],
      ['lib', 'webbluetooth'],
      ['lib', 'websocket'],
      ['lib', 'resolve-bindings-web.js']
    ]) {
      await removeWithin(root, path.join(nobleDir, ...relativePath));
    }

    await keepOnlyFiles(
      path.join(nobleDir, 'build', 'Release'),
      root,
      new Set(['binding.node'])
    );
  }
}

async function pruneSerialportBindings(nodeModulesDir, root) {
  const bindingsDir = packagePath(nodeModulesDir, '@serialport/bindings-cpp');
  if (!(await pathExists(bindingsDir))) return;

  await removeWithin(root, path.join(bindingsDir, 'src'));
  await removeWithin(root, path.join(bindingsDir, 'build'));
  await prunePrebuildDirectories(bindingsDir, root);
}

async function minimizeRuntimeDependencies(packageDir) {
  const nodeModulesDir = path.join(packageDir, 'node_modules');
  if (!(await pathExists(nodeModulesDir))) return;

  const beforeBytes = await directorySize(nodeModulesDir);

  await removeWithin(packageDir, path.join(packageDir, 'package-lock.json'));
  await removeWithin(packageDir, path.join(nodeModulesDir, '.package-lock.json'));
  await removePackagesFromNodeModulesDirs(packageDir, packageDir, installOnlyPackages);
  await pruneNoble(nodeModulesDir, packageDir);
  await pruneSerialportBindings(nodeModulesDir, packageDir);
  await prunePrebuildDirectories(nodeModulesDir, packageDir);
  await pruneCommonFiles(nodeModulesDir, packageDir);
  await removeEmptyDirectories(nodeModulesDir, packageDir);

  const afterBytes = await directorySize(nodeModulesDir);
  if (beforeBytes !== afterBytes) {
    console.log(`  minimized runtime dependencies: ${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}`);
  }
}

async function copyRuntimeAssets(project, distDir, warnings) {
  for (const dirName of assetDirs) {
    if (dirName === 'ui' && hasPackageScript(project, 'build:ui')) {
      continue;
    }

    const source = path.join(project.dir, dirName);
    const destination = path.join(distDir, dirName);
    if (await pathExists(source)) {
      await cp(source, destination, { recursive: true });
    }
  }

  for (const file of vendorFiles) {
    await copyIfExists(
      path.join(project.dir, ...file.from),
      path.join(distDir, ...file.to),
      file.from.join('/'),
      warnings
    );
  }

}

async function writeRuntimePackage(project, packageDir) {
  await writeFile(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify(rewriteDistPackageJson(project), null, 2)}\n`,
    'utf8'
  );
}

async function installRuntimeDependencies(project, packageDir) {
  const runtimeDependencies = getRuntimeDependencies(project);
  if (!Object.keys(runtimeDependencies).length) return;

  if (await copyRuntimeDependenciesFromSource(project, packageDir, runtimeDependencies)) {
    return;
  }

  console.log(`  installing runtime dependencies in ${toDisplayPath(packageDir)}`);
  await runCommand(
    npmCommand,
    ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'],
    { cwd: packageDir }
  );
  await minimizeRuntimeDependencies(packageDir);
}

async function buildProject(project) {
  const entry = path.resolve(project.dir, project.packageJson.main || 'index.js');
  const distRoot = path.join(project.dir, 'dist');
  const packageDir = path.join(distRoot, project.id);
  const outfile = path.join(packageDir, 'index.js');
  const warnings = [];

  if (!(await pathExists(entry))) {
    throw new Error(`${project.id} entry not found: ${toDisplayPath(entry)}`);
  }

  assertWithin(project.dir, distRoot);
  assertWithin(project.dir, packageDir);
  if (path.basename(distRoot) !== 'dist') {
    throw new Error(`Unexpected dist directory: ${distRoot}`);
  }

  await emptyDirectory(distRoot);
  await mkdir(packageDir, { recursive: true });

  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: nodeTarget,
    external: [...builtinExternals, ...runtimeExternalPatterns],
    legalComments: 'none',
    minify: true,
    sourcemap: false,
    logLevel: 'silent'
  });

  for (const warning of result.warnings) {
    warnings.push(warning.text);
  }

  await chmod(outfile, 0o755).catch(() => undefined);
  await writeRuntimePackage(project, packageDir);
  await installRuntimeDependencies(project, packageDir);
  await copyRuntimeAssets(project, packageDir, warnings);
  await runPackageScriptWithArgs(project, 'build:ui', [
    '--outdir',
    path.join(packageDir, 'ui')
  ]);

  return {
    project,
    outfile,
    warnings
  };
}

function createWorkspaceIndex(results, indexTemplate) {
  const remainingResults = new Map(results.map(result => [result.project.id, result]));
  const index = {};

  for (const [key, entry] of Object.entries(indexTemplate)) {
    const result = Array.from(remainingResults.values())
      .find(item => indexEntryMatchesProject(key, entry, item.project));

    if (!result) continue;

    index[key] = entry;
    remainingResults.delete(result.project.id);
  }

  for (const result of remainingResults.values()) {
    index[result.project.id] = createFallbackIndexEntry(result.project);
  }

  return index;
}

async function publishWorkspaceDist(results) {
  const workspaceDistDir = path.join(rootDir, 'dist');
  assertWithin(rootDir, workspaceDistDir);
  if (path.basename(workspaceDistDir) !== 'dist') {
    throw new Error(`Unexpected workspace dist directory: ${workspaceDistDir}`);
  }

  await emptyDirectory(workspaceDistDir);

  for (const result of results) {
    const projectDistDir = path.join(result.project.dir, 'dist');
    await copyDirectoryContents(projectDistDir, workspaceDistDir);
  }

  const indexTemplate = await loadIndexTemplate();
  const workspaceIndex = createWorkspaceIndex(results, indexTemplate);
  await writeFile(
    path.join(workspaceDistDir, 'index.json'),
    `${JSON.stringify(workspaceIndex, null, 2)}\n`,
    'utf8'
  );

  return workspaceDistDir;
}

function printHelp() {
  console.log(`Usage: npm run build -- [project...]

Build all tool projects with esbuild into each project's dist/<project> directory,
then publish the built tools and index.json into the workspace dist directory.

Examples:
  npm run build
  npm run build -- ble-debugger
  npm run build -- @aily-project/subapp-ble-debugger`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const projects = await discoverProjects();
  const selectedProjects = selectProjects(projects, args);

  if (!selectedProjects.length) {
    throw new Error('No tool projects found.');
  }

  console.log(`Building ${selectedProjects.length} project(s) for ${nodeTarget}...`);

  const results = [];
  for (const project of selectedProjects) {
    const result = await buildProject(project);
    results.push(result);
    console.log(`- ${project.id} -> ${toDisplayPath(result.outfile)}`);
    for (const warning of result.warnings) {
      console.warn(`  warning: ${warning}`);
    }
  }

  const workspaceDistDir = await publishWorkspaceDist(results);
  console.log(`Published workspace dist -> ${toDisplayPath(workspaceDistDir)}`);
  console.log(`Done. Built ${results.length} project(s).`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
