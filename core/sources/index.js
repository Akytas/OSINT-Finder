const { toUnifiedResult } = require('../../utils/unifiedResult');
const fs = require('node:fs');
const path = require('node:path');

const providersDir = path.resolve(__dirname, '../../providers');

function listProviderFilesRecursively(directory, rootDir = directory) {
  if (!fs.existsSync(directory)) return [];

  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = [];

  entries.forEach((entry) => {
    if (entry.name.startsWith('_')) return;

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProviderFilesRecursively(absolutePath, rootDir));
      return;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(absolutePath);
    }
  });

  return files.sort((a, b) =>
    path
      .relative(rootDir, a)
      .replace(/\\/g, '/')
      .localeCompare(path.relative(rootDir, b).replace(/\\/g, '/'))
  );
}

function assertNotAborted(signal) {
  if (signal && signal.aborted) {
    throw new Error('Source run aborted.');
  }
}

function toItemArray(providerOutput) {
  if (!providerOutput) return [];
  if (Array.isArray(providerOutput)) return providerOutput;

  if (providerOutput && typeof providerOutput === 'object') {
    if (Array.isArray(providerOutput.items)) {
      return providerOutput.items;
    }
    return [providerOutput];
  }

  return [];
}

function resolveImageUrl(input) {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';

  const candidates = [input.imageUrl, input.url, input.image, input.targetUrl];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function loadProviderPlugins() {
  const directory = providersDir;

  if (!fs.existsSync(directory)) return [];

  const providerFiles = listProviderFilesRecursively(directory);

  const plugins = providerFiles
    .map((absoluteFilePath) => {
      const file = path.relative(directory, absoluteFilePath).replace(/\\/g, '/');
      let plugin = null;
      try {
        plugin = require(absoluteFilePath);
      } catch (error) {
        console.warn(
          `Provider ${file} nebyl nacten (chyba require): ${error instanceof Error ? error.message : 'neznamy problem'}.`
        );
        return null;
      }

      if (!plugin || typeof plugin !== 'object') {
        console.warn(`Provider ${file} nebyl nacten (neplatny export).`);
        return null;
      }
      if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
        console.warn(`Provider ${file} nebyl nacten (chybi name).`);
        return null;
      }
      if (typeof plugin.run !== 'function') {
        console.warn(`Provider ${file} nebyl nacten (chybi run()).`);
        return null;
      }
      if (typeof plugin.parse !== 'function') {
        console.warn(`Provider ${file} nebyl nacten (chybi parse()).`);
        return null;
      }
      return plugin;
    })
    .filter(Boolean);

  const providerNames = plugins.map((plugin) => plugin.name).sort((a, b) => a.localeCompare(b));
  console.log('Nactene providery:', providerNames);
  console.info(
    `[Sources] Nacteno ${plugins.length}/${providerFiles.length} provider pluginu: ${providerNames.join(', ') || '-'}.`
  );

  return plugins;
}

function makeSource(plugin) {
  return {
    name: plugin.name,
    async run(input, context = {}) {
      const { signal } = context;
      assertNotAborted(signal);

      const imageUrl = resolveImageUrl(input);
      if (!imageUrl) {
        throw new Error('Missing image URL in input.');
      }

      try {
        const rawData = await plugin.run(input, {
          ...context,
          imageUrl
        });

        assertNotAborted(signal);

        const parsed = plugin.parse(rawData, {
          ...context,
          imageUrl,
          input
        });

        const rawItems = toItemArray(parsed);
        const unifiedCandidates = rawItems.map((item) =>
          toUnifiedResult(plugin.name, item, { imageUrl })
        );
        const unifiedItems = unifiedCandidates.filter(Boolean);
        console.log(`[${plugin.name}]`, unifiedItems.length, 'vysledku');

        const droppedCount = unifiedCandidates.length - unifiedItems.length;
        if (droppedCount > 0) {
          console.warn(
            `[Provider ${plugin.name}] toUnifiedResult zahodil ${droppedCount}/${unifiedCandidates.length} polozek.`
          );
        }

        if (rawItems.length > 0 && unifiedItems.length === 0) {
          console.warn(
            `[Provider ${plugin.name}] provider vratil ${rawItems.length} polozek, ale po normalizaci nezustala zadna.`
          );
        }

        assertNotAborted(signal);

        return {
          source: plugin.name,
          items: unifiedItems
        };
      } catch (error) {
        if (signal && signal.aborted) {
          throw error;
        }

        console.error(`[Provider ${plugin.name}] run failed:`, error);
        return {
          source: plugin.name,
          items: []
        };
      }
    }
  };
}

module.exports = Object.fromEntries(
  loadProviderPlugins().map((plugin) => [plugin.name, makeSource(plugin)])
);
