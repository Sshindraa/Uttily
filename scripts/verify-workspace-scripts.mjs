import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(scriptDirectory, '..');

const LOCAL_SCRIPT_PATH_PATTERN =
  /(?:^|[\s"'=])((?:\.\.?\/)?(?:scripts|src)\/[A-Za-z0-9_./-]+|(?:\.\/?)*build\.mjs)(?=$|[\s"'=])/g;
const GLOB_CHARACTER_PATTERN = /[*?\[\]]/;

/**
 * Extrait les chemins de fichiers locaux mentionnés par une commande de script.
 * Les motifs Vitest contenant un joker sont volontairement ignorés : ils ne
 * désignent pas un fichier unique à vérifier.
 */
export function extractScriptFileReferences(command) {
  const references = new Set();
  for (const match of command.matchAll(LOCAL_SCRIPT_PATH_PATTERN)) {
    const reference = match[1];
    if (!GLOB_CHARACTER_PATTERN.test(reference)) references.add(reference);
  }
  return [...references];
}

function workspacePackageDirectories(repositoryRoot) {
  const directories = [repositoryRoot];
  for (const workspaceDirectory of ['apps', 'packages']) {
    const directory = join(repositoryRoot, workspaceDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(directory, entry.name));
    }
  }
  return directories;
}

export function workspaceManifests(repositoryRoot = REPOSITORY_ROOT) {
  return workspacePackageDirectories(repositoryRoot).map((directory) =>
    join(directory, 'package.json'),
  );
}

export function findMissingScriptFiles(repositoryRoot = REPOSITORY_ROOT) {
  const missing = [];

  for (const manifestPath of workspaceManifests(repositoryRoot)) {
    if (!existsSync(manifestPath)) continue;

    const packageDirectory = dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
      for (const reference of extractScriptFileReferences(command)) {
        const target = resolve(packageDirectory, reference);
        if (!existsSync(target)) {
          missing.push({
            packageName: manifest.name ?? relative(repositoryRoot, packageDirectory),
            scriptName,
            reference,
            target: relative(repositoryRoot, target),
          });
        }
      }
    }
  }

  return missing;
}

export function verifyWorkspaceScripts(repositoryRoot = REPOSITORY_ROOT) {
  const missing = findMissingScriptFiles(repositoryRoot);
  if (missing.length > 0) {
    const details = missing
      .map(
        ({ packageName, scriptName, reference, target }) =>
          `- ${packageName}#${scriptName}: ${reference} -> ${target}`,
      )
      .join('\n');
    throw new Error(`Références de scripts introuvables :\n${details}`);
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyWorkspaceScripts();
  console.log('Workspace script references: OK');
}
