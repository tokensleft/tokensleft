import js from '@eslint/js';
import globals from 'globals';

export default [
  // Worktrees and coverage output live under these paths; never lint them.
  { ignores: ['node_modules/', '.claude/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Terminal text is the whole point here: sanitizers match control
      // characters on purpose, and tests match exact column spacing.
      'no-control-regex': 'off',
      'no-regex-spaces': 'off',
    },
  },
];
