import path from 'node:path';
import { assert, integer, text } from './util.js';

export function preparationForTask(project, task) {
  return ['work', 'repair', 'review'].includes(task.kind) && task.reviewScope !== 'goal' ? project?.preparation : null;
}

export function normalizePreparation(value) {
  if (value == null) return null;
  assert(typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', 'Preparation must be an object or null');
  const command = text(value.command, 'preparation.command', 4096);
  const args = value.args;
  assert(path.isAbsolute(command) && !command.includes('\0'), 'INVALID_INPUT', 'Preparation requires an absolute executable');
  assert(Array.isArray(args) && args.length <= 40 && args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0')),
    'INVALID_INPUT', 'Preparation args must be an array of literal arguments');
  const network = value.network ?? 'offline-npm';
  assert(['offline-npm', 'allow'].includes(network), 'INVALID_INPUT', 'Preparation network must be offline-npm or allow');
  if (network === 'offline-npm') assert(/^node(?:\.exe)?$/i.test(path.basename(command)) &&
    args.length === 1 && path.isAbsolute(args[0]) && path.basename(args[0]) === 'npm-cli.js',
    'INVALID_INPUT', 'Offline npm preparation requires an absolute node executable and one absolute npm-cli.js argument');
  const inputs = value.inputs ?? ['package-lock.json', 'package.json'];
  assert(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 20 && inputs.every(file =>
    typeof file === 'string' && /^[\w.@/-]+$/.test(file) && !file.split('/').some(part => !part || part === '..' || part === '.')),
    'INVALID_INPUT', 'Preparation inputs must be relative lock or configuration files');
  if (network === 'offline-npm') assert(inputs.includes('package-lock.json') && inputs.includes('package.json'),
    'INVALID_INPUT', 'Offline npm preparation must track package-lock.json and package.json');
  const cacheSeed = value.cacheSeed ?? null;
  assert(cacheSeed === null || (network === 'offline-npm' && typeof cacheSeed === 'string' && path.isAbsolute(cacheSeed) && !cacheSeed.includes('\0')),
    'INVALID_INPUT', 'An offline npm cache seed must be an absolute directory');
  return { command, args, network, inputs: [...new Set(inputs)].sort(), cacheSeed,
    timeoutMs: integer(value.timeoutMs ?? 120000, 'preparation.timeoutMs', 1, 1200000) };
}
