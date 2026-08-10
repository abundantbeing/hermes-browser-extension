import {
  BUILTIN_COMMANDS,
  parseBrowserCommand,
} from './commands.mjs';

export const WEB_COMMANDS = Object.freeze(
  BUILTIN_COMMANDS.filter((command) => !command.surfaces || command.surfaces.includes('fulltab')),
);

const WEB_COMMAND_NAMES = new Set(WEB_COMMANDS.map((command) => command.name));

export function parseWebCommand(input = '') {
  const parsed = parseBrowserCommand(input);
  if (!parsed || parsed.kind !== 'native' || !WEB_COMMAND_NAMES.has(parsed.command.name)) return null;
  return parsed;
}

export function webCommandSuggestions(input = '', limit = 8) {
  const match = String(input || '').match(/(?:^|\s)\/([a-z0-9_-]*)$/i);
  if (!match) return [];
  const needle = String(match[1] || '').toLowerCase();
  return WEB_COMMANDS
    .filter((command) => !needle
      || command.name.includes(needle)
      || (command.aliases || []).some((alias) => alias.includes(needle))
      || command.description.toLowerCase().includes(needle))
    .slice(0, limit);
}

export function webComposerSuggestionMode(input = '', { force = false } = {}) {
  if (force) return 'commands';
  return /(?:^|\s)[/@][a-z0-9_-]*$/i.test(String(input || '')) ? 'typed' : 'none';
}
