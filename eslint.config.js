import js from '@eslint/js';
import security from 'eslint-plugin-security';

export default [
  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser extension APIs
        chrome: 'readonly',
        // Web standards
        document: 'readonly',
        window: 'readonly',
        globalThis: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        DOMParser: 'readonly',
        MutationObserver: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileList: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        DOMException: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MediaRecorder: 'readonly',
        WebSocket: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'warn',
      'prefer-template': 'warn',
      'no-throw-literal': 'warn',
      'prefer-object-spread': 'warn',
    },
  },

  {
    files: ['scripts/**', 'tests/**'],
    languageOptions: {
      globals: {
        // Node.js globals
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        global: 'readonly',
      },
    },
  },

  {
    files: ['scripts/**', 'tests/**'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^(assert|test)$' }],
    },
  },

  // Security regression rules: flag dangerous patterns (eval, non-literal
  // regexp, ReDoS-susceptible regexes, object injection, trojan-source
  // bidi characters) on new code. Recommended set runs at warn so existing
  // noise does not block development; eval is hard-banned because the
  // extension must never execute dynamically constructed code.
  {
    files: ['extension/**/*.js', 'extension/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
    ...security.configs.recommended,
    rules: {
      ...security.configs.recommended.rules,
      'security/detect-eval-with-expression': 'error',
      'no-new-func': 'error',
    },
  },

  {
    ignores: [
      'dist/',
      'artifacts/',
      'node_modules/',
      '.gitnexus/',
      '.hermes/',
      'backups/',
      'tmp/',
      'docs/',
      'extension/lib/vendor/', // third-party, byte-for-byte pinned copies (see vendor README)
    ],
  },
];
