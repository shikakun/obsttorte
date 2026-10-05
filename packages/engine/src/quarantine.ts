export type QuarantineRule = {
  configDir: string;
  codeConfiguredPluginIds: readonly string[];
};

const PLUGIN_AUTO_APPLIED_FILES = new Set(["data.json", "styles.css"]);

export function createQuarantineMatcher(rule: QuarantineRule): (path: string) => boolean {
  const pluginsDir = `${rule.configDir}/plugins/`;
  const alwaysQuarantined = new Set([
    `${rule.configDir}/community-plugins.json`,
    `${rule.configDir}/obsttorte.json`,
    ...rule.codeConfiguredPluginIds.map((pluginId) => `${pluginsDir}${pluginId}/data.json`),
  ]);

  return (path) => {
    if (alwaysQuarantined.has(path)) return true;
    if (!path.startsWith(pluginsDir)) return false;
    const [pluginId, ...rest] = path.slice(pluginsDir.length).split("/");
    if (!pluginId || rest.length === 0) return false;
    return rest.length > 1 || !PLUGIN_AUTO_APPLIED_FILES.has(rest[0] ?? "");
  };
}

export function pluginIdFromPath(path: string, configDir: string): string | null {
  const prefix = `${configDir}/plugins/`;
  if (!path.startsWith(prefix)) return null;
  const [pluginId, ...rest] = path.slice(prefix.length).split("/");
  if (!pluginId || rest.length === 0) return null;
  return pluginId;
}

export function findNewPluginIds(
  paths: readonly string[],
  configDir: string,
  knownPluginIds: readonly string[],
): string[] {
  const known = new Set(knownPluginIds);
  const found = new Set<string>();
  for (const path of paths) {
    const pluginId = pluginIdFromPath(path, configDir);
    if (pluginId && !known.has(pluginId)) found.add(pluginId);
  }
  return [...found];
}

export function isNewPluginPath(
  path: string,
  configDir: string,
  newPluginIds: readonly string[],
): boolean {
  const pluginId = pluginIdFromPath(path, configDir);
  return pluginId !== null && newPluginIds.includes(pluginId);
}

export function isStyleChange(path: string, configDir: string): boolean {
  if (path.startsWith(`${configDir}/themes/`)) return true;
  if (path.startsWith(`${configDir}/snippets/`) && path.endsWith(".css")) return true;
  return path.startsWith(`${configDir}/plugins/`) && path.endsWith("/styles.css");
}

export function isUnderConfig(path: string, configDir: string): boolean {
  return path === configDir || path.startsWith(`${configDir}/`);
}
