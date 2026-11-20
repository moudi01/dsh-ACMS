const excluded = new Set(['.git', '.acms', '.codex', '.aws', '.ssh', '.npmrc', '.netrc', 'node_modules', 'auth.json', 'credentials.json']);

export const includedProjectInput = (name, dependencies = false) => (dependencies && name.toLowerCase() === 'node_modules') ||
  (!excluded.has(name.toLowerCase()) && !name.toLowerCase().startsWith('.env'));
