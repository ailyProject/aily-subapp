#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(rootDir, 'dist', 'subapp-index.json');
const defaultLocale = 'en';
const defaultIcon = 'fa-light fa-puzzle-piece';

async function pathExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return false;
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read JSON ${path.relative(rootDir, filePath)}: ${error.message}`);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function childDirBaseName(entry) {
  const childDir = String(entry?.childDir || '').replace(/\\/g, '/');
  return childDir.split('/').filter(Boolean).pop() || '';
}

function findLegacyEntry(indexTemplate, projectId) {
  for (const [key, entry] of Object.entries(indexTemplate)) {
    if (key === projectId || entry?.id === projectId || childDirBaseName(entry) === projectId) {
      return entry;
    }
  }
  return null;
}

async function loadLegacyIndex() {
  const filePath = path.join(rootDir, 'index-backup.json');
  return await pathExists(filePath) ? readJson(filePath) : {};
}

async function discoverProjects() {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (['dist', 'node_modules', 'scripts', 'templates'].includes(entry.name)) continue;

    const dir = path.join(rootDir, entry.name);
    const packagePath = path.join(dir, 'package.json');
    if (!(await pathExists(packagePath))) continue;

    projects.push({
      dir,
      directoryId: entry.name,
      packageJson: await readJson(packagePath)
    });
  }

  return projects.sort((left, right) => left.directoryId.localeCompare(right.directoryId));
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function firstNamespace(translation, label) {
  const namespaces = Object.keys(translation).filter(key => isObject(translation[key]));
  if (!namespaces.length) {
    throw new Error(`${label} must contain a top-level translation namespace`);
  }
  return namespaces[0];
}

function relativeTranslationKey(fullKey, namespace, label) {
  const prefix = `${namespace}.`;
  if (!fullKey.startsWith(prefix) || fullKey.length === prefix.length) {
    throw new Error(`${label} must be inside namespace ${namespace}`);
  }
  return fullKey.slice(prefix.length);
}

function getNestedValue(source, relativeKey) {
  return relativeKey.split('.').reduce((value, key) => (
    isObject(value) ? value[key] : undefined
  ), source);
}

function setNestedValue(target, relativeKey, value) {
  const segments = relativeKey.split('.');
  let cursor = target;

  for (const segment of segments.slice(0, -1)) {
    if (!isObject(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment];
  }

  cursor[segments.at(-1)] = value;
}

function normalizeLocale(fileName) {
  return path.basename(fileName, '.json').trim().toLowerCase().replace(/-/g, '_');
}

function sortLocales(locales, configuredDefaultLocale) {
  return [...locales].sort((left, right) => {
    if (left === configuredDefaultLocale) return -1;
    if (right === configuredDefaultLocale) return 1;
    return left.localeCompare(right);
  });
}

async function loadCatalogTranslations(project, metadata) {
  const i18nDir = path.join(project.dir, metadata.i18nDir);
  const files = (await readdir(i18nDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'));

  const fileByLocale = new Map();
  for (const file of files) {
    const locale = normalizeLocale(file.name);
    if (fileByLocale.has(locale)) {
      throw new Error(`${project.directoryId} contains duplicate locale ${locale}`);
    }
    fileByLocale.set(locale, path.join(i18nDir, file.name));
  }

  if (!fileByLocale.has(metadata.defaultLocale)) {
    throw new Error(`${project.directoryId} is missing i18n/${metadata.defaultLocale}.json`);
  }

  const defaultData = await readJson(fileByLocale.get(metadata.defaultLocale));
  const defaultNamespaceData = defaultData[metadata.namespace];
  if (!isObject(defaultNamespaceData)) {
    throw new Error(`${project.directoryId} default locale is missing namespace ${metadata.namespace}`);
  }

  const defaultTitle = getNestedValue(defaultNamespaceData, metadata.relativeTitleKey);
  const defaultDescription = getNestedValue(defaultNamespaceData, metadata.relativeDescriptionKey);
  requireString(defaultTitle, `${project.directoryId} ${metadata.titleKey}`);
  requireString(defaultDescription, `${project.directoryId} ${metadata.descriptionKey}`);

  const locales = {};
  for (const locale of sortLocales(fileByLocale.keys(), metadata.defaultLocale)) {
    const data = await readJson(fileByLocale.get(locale));
    const namespaceData = data[metadata.namespace];
    if (!isObject(namespaceData)) {
      throw new Error(`${project.directoryId} locale ${locale} is missing namespace ${metadata.namespace}`);
    }

    const title = getNestedValue(namespaceData, metadata.relativeTitleKey) ?? defaultTitle;
    const description = getNestedValue(namespaceData, metadata.relativeDescriptionKey) ?? defaultDescription;
    requireString(title, `${project.directoryId} ${locale} ${metadata.titleKey}`);
    requireString(description, `${project.directoryId} ${locale} ${metadata.descriptionKey}`);

    const summary = {};
    setNestedValue(summary, metadata.relativeTitleKey, title);
    setNestedValue(summary, metadata.relativeDescriptionKey, description);
    locales[locale] = summary;
  }

  return locales;
}

async function createCatalogEntry(project, legacyEntry) {
  const packageJson = project.packageJson;
  const subapp = isObject(packageJson.ailySubapp) ? packageJson.ailySubapp : {};
  const id = requireString(subapp.id || project.directoryId, `${project.directoryId} subapp id`);
  const packageName = requireString(
    subapp.package || packageJson.name,
    `${project.directoryId} published package name`
  );
  const packageVersion = requireString(
    packageJson.version,
    `${project.directoryId} published package version`
  );
  const i18nDir = requireString(subapp.i18n?.dir || 'i18n', `${id} i18n directory`);
  const configuredDefaultLocale = normalizeLocale(subapp.i18n?.defaultLocale || defaultLocale);
  const defaultTranslationPath = path.join(project.dir, i18nDir, `${configuredDefaultLocale}.json`);
  const defaultTranslation = await readJson(defaultTranslationPath);
  const namespace = requireString(
    subapp.namespace || legacyEntry?.namespace || firstNamespace(defaultTranslation, `${id} default translation`),
    `${id} namespace`
  );
  const titleKey = requireString(
    subapp.titleKey || legacyEntry?.titleKey || `${namespace}.TITLE`,
    `${id} titleKey`
  );
  const descriptionKey = requireString(
    subapp.descriptionKey || legacyEntry?.app?.description || `${namespace}.DESCRIPTION`,
    `${id} descriptionKey`
  );
  const metadata = {
    defaultLocale: configuredDefaultLocale,
    descriptionKey,
    i18nDir,
    namespace,
    relativeDescriptionKey: relativeTranslationKey(descriptionKey, namespace, `${id} descriptionKey`),
    relativeTitleKey: relativeTranslationKey(titleKey, namespace, `${id} titleKey`),
    titleKey
  };
  const locales = await loadCatalogTranslations(project, metadata);
  const appMetadata = isObject(subapp.app) ? subapp.app : {};
  const legacyApp = isObject(legacyEntry?.app) ? legacyEntry.app : {};

  const result = {
    id,
    titleKey,
    namespace,
    app: {
      name: titleKey,
      description: descriptionKey,
      icon: appMetadata.icon || legacyApp.icon || defaultIcon,
      enabled: appMetadata.enabled ?? legacyApp.enabled ?? true
    },
    package: packageName,
    version: packageVersion,
    i18n: {
      defaultLocale: configuredDefaultLocale,
      locales
    }
  };

  if (isObject(subapp.compatibility)) {
    result.compatibility = subapp.compatibility;
  }

  return result;
}

async function generateIndex() {
  const projects = await discoverProjects();
  if (!projects.length) throw new Error('No subapp projects found');

  const legacyIndex = await loadLegacyIndex();
  const apps = {};
  const packageNames = new Set();
  const namespaces = new Set();

  for (const project of projects) {
    const entry = await createCatalogEntry(
      project,
      findLegacyEntry(legacyIndex, project.directoryId)
    );

    if (apps[entry.id]) throw new Error(`Duplicate subapp id: ${entry.id}`);
    if (packageNames.has(entry.package)) throw new Error(`Duplicate package name: ${entry.package}`);
    if (namespaces.has(entry.namespace)) throw new Error(`Duplicate i18n namespace: ${entry.namespace}`);

    apps[entry.id] = entry;
    packageNames.add(entry.package);
    namespaces.add(entry.namespace);
  }

  return apps;
}

async function main() {
  const index = await generateIndex();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`Generated ${path.relative(rootDir, outputPath)} with ${Object.keys(index).length} subapps.`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
