#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const booleanOptions = new Set(['help', 'skip-build', 'skip-install', 'unlink'])

function parseArgs(argv) {
  const options = { selectors: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      options.selectors.push(arg)
      continue
    }
    const equalIndex = arg.indexOf('=')
    const key = equalIndex >= 0 ? arg.slice(2, equalIndex) : arg.slice(2)
    let value = equalIndex >= 0 ? arg.slice(equalIndex + 1) : true
    if (!booleanOptions.has(key) && equalIndex < 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      value = argv[++index]
    }
    options[key] = value
  }
  return options
}

function defaultAppDataPath() {
  if (process.env.AILY_APPDATA_PATH) return path.resolve(process.env.AILY_APPDATA_PATH)
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Local', 'aily-project')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'aily-project')
  return path.join(os.homedir(), '.config', 'aily-project')
}

function resolveInstallRoot(options) {
  const configured = options['app-root'] || process.env.AILY_SUBAPP_INSTALL_ROOT
  return configured
    ? path.resolve(String(configured))
    : path.join(defaultAppDataPath(), 'npm-global', 'app')
}

async function ensureInstallProject(installRoot) {
  await mkdir(installRoot, { recursive: true })
  const packageJsonPath = path.join(installRoot, 'package.json')
  if (existsSync(packageJsonPath)) return
  await writeFile(packageJsonPath, `${JSON.stringify({
    name: 'aily-installed-subapps',
    private: true,
    version: '1.0.0',
    description: 'Aily Blockly user-installed child applications',
    dependencies: {},
  }, null, 2)}\n`)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.toLowerCase().replaceAll('-', '_') === 'npm_config_manage_package_manager_versions') {
        delete env[key]
      }
    }
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

async function discoverProjects() {
  const entries = await readdir(rootDir, { withFileTypes: true })
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'scripts') continue
    const dir = path.join(rootDir, entry.name)
    const packageJsonPath = path.join(dir, 'package.json')
    if (!existsSync(packageJsonPath) || !existsSync(path.join(dir, 'index.js'))) continue
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    projects.push({ id: entry.name, dir, packageJson })
  }
  return projects.sort((left, right) => left.id.localeCompare(right.id))
}

function selectProjects(projects, selectors) {
  if (!selectors.length) return projects
  const selected = []
  const missing = []
  for (const selector of selectors) {
    const project = projects.find(candidate => candidate.id === selector || candidate.packageJson.name === selector)
    if (project && !selected.includes(project)) selected.push(project)
    else if (!project) missing.push(selector)
  }
  if (missing.length) throw new Error(`Unknown child application: ${missing.join(', ')}`)
  return selected
}

function packageLinkPath(installRoot, packageName) {
  return path.join(installRoot, 'node_modules', ...packageName.split('/'))
}

async function statPath(filePath) {
  try {
    return await lstat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function packageBackupPath(linkPath) {
  return `${linkPath}.aily-dev-backup`
}

async function verifyLink(installRoot, project) {
  const linkPath = packageLinkPath(installRoot, project.packageJson.name)
  if (!existsSync(linkPath)) throw new Error(`Development link was not created: ${linkPath}`)
  const resolved = await realpath(linkPath)
  if (resolved !== await realpath(project.dir)) {
    throw new Error(`Unexpected npm link target for ${project.packageJson.name}: ${resolved}`)
  }
  return linkPath
}

async function linkSourcePackage(installRoot, project) {
  const packageName = project.packageJson.name
  const linkPath = packageLinkPath(installRoot, packageName)
  const backupPath = packageBackupPath(linkPath)
  await mkdir(path.dirname(linkPath), { recursive: true })

  const current = await statPath(linkPath)
  if (current?.isSymbolicLink()) {
    try {
      if (await realpath(linkPath) === await realpath(project.dir)) {
        return { linkPath, replaced: Boolean(await statPath(backupPath)) }
      }
    } catch {
      // Replace broken development links below.
    }
  }

  if (current) {
    if (await statPath(backupPath)) {
      throw new Error(`Cannot replace ${linkPath}: development backup already exists at ${backupPath}`)
    }
    await rename(linkPath, backupPath)
  }

  try {
    await symlink(project.dir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (current && await statPath(backupPath) && !(await statPath(linkPath))) {
      await rename(backupPath, linkPath)
    }
    throw error
  }

  await verifyLink(installRoot, project)
  return { linkPath, replaced: Boolean(current) }
}

async function unlinkSourcePackage(installRoot, project) {
  const linkPath = packageLinkPath(installRoot, project.packageJson.name)
  const backupPath = packageBackupPath(linkPath)
  const current = await statPath(linkPath)

  if (current) {
    if (!current.isSymbolicLink()) {
      throw new Error(`Refusing to unlink non-symlink package: ${linkPath}`)
    }
    let resolved = ''
    try {
      resolved = await realpath(linkPath)
    } catch {
      // A broken symlink is safe to remove.
    }
    if (resolved && resolved !== await realpath(project.dir)) {
      throw new Error(`Refusing to unlink a different source package: ${linkPath} -> ${resolved}`)
    }
    await unlink(linkPath)
  }

  if (await statPath(backupPath)) {
    await rename(backupPath, linkPath)
    return { linkPath, restored: true }
  }
  return { linkPath, restored: false }
}

function findUiIndex(project) {
  const candidates = [
    path.join(project.dir, 'ui', 'index.html'),
    path.join(project.dir, 'dist', project.id, 'ui', 'index.html'),
  ]
  return candidates.find(candidate => existsSync(candidate)) || ''
}

function printHelp() {
  console.log(`Usage: npm run dev:link -- [tool-id ...] [options]

Install local tool dependencies, prepare framework UIs, and link selected source
packages into the Aily Blockly user-level npm subapp directory. With no tool id,
all source packages are linked.

Options:
  --app-root <path>  Override the npm-global/app target
  --skip-install     Reuse existing source dependencies
  --skip-build       Reuse existing UI build output
  --unlink           Remove selected development links
  --help             Show this help

Environment:
  AILY_SUBAPP_INSTALL_ROOT  Direct npm-global/app override
  AILY_APPDATA_PATH         Aily application-data root override`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const projects = selectProjects(await discoverProjects(), options.selectors)
if (!projects.length) throw new Error('No child application source packages were found')

const installRoot = resolveInstallRoot(options)
await ensureInstallProject(installRoot)
for (const project of projects) {
  const packageName = String(project.packageJson.name || '').trim()
  if (!packageName) throw new Error(`${project.id}/package.json is missing name`)

  if (options.unlink) {
    const result = await unlinkSourcePackage(installRoot, project)
    console.log(`Unlinked ${packageName} from ${installRoot}${result.restored ? ' and restored the installed package' : ''}`)
    continue
  }

  if (!options['skip-install']) {
    await run(npmCommand, ['install', '--no-audit', '--no-fund'], { cwd: project.dir })
    const uiDir = path.join(project.dir, 'ui')
    if (existsSync(path.join(uiDir, 'package.json'))) {
      await run(npmCommand, ['install', '--no-audit', '--no-fund'], { cwd: uiDir })
    }
  }

  if (!options['skip-build'] && project.packageJson.scripts?.['build:ui']) {
    await run(npmCommand, ['run', 'build:ui'], { cwd: project.dir })
  }
  if (!findUiIndex(project)) {
    throw new Error(`${project.id} UI entry was not found; build the UI before linking`)
  }

  const result = await linkSourcePackage(installRoot, project)
  console.log(`Linked ${packageName}: ${result.linkPath} -> ${project.dir}${result.replaced ? ' (installed package backed up)' : ''}`)
}

console.log(`Development subapps are available through ${installRoot}`)
