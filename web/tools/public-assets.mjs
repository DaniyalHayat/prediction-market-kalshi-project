import {cp, lstat, readdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const publicSource = fileURLToPath(new URL('../public/', import.meta.url));
const retiredNames = new Set(['index.html', 'runtime.js', 'data-app-build.json', 'cloud-navigation.js']);
const retiredReports = ['research/research-audit.pdf'];

async function retiredReportAssets(publicDirectory) {
  const found = [];
  for (const name of retiredReports) {
    const path = join(publicDirectory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error('Expected a retired report file: ' + path);
      found.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return found;
}

async function retiredDashboardAssets(publicDirectory) {
  const dashboard = join(publicDirectory, 'dashboard');
  let info;
  try {
    info = await lstat(dashboard);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!info.isDirectory()) throw new Error('Expected a dashboard asset directory: ' + dashboard);
  const names = await readdir(dashboard);
  return names
    .filter(name => retiredNames.has(name) || /^snapshot\.[a-f0-9]{64}\.json$/i.test(name))
    .map(name => join(dashboard, name));
}

export async function assertCurrentPublicAssets(source = publicSource) {
  const retired = [...await retiredDashboardAssets(source), ...await retiredReportAssets(source)];
  if (retired.length) throw new Error('Retired files in public assets: ' + retired.join(', '));
}

export async function copyPublicAssets(destination, source = publicSource) {
  await assertCurrentPublicAssets(source);
  for (const path of await retiredDashboardAssets(destination)) await unlink(path);
  for (const path of await retiredReportAssets(destination)) await unlink(path);
  await cp(source, destination, {recursive: true});
}
