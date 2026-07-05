module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
    browser: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'script'
  },
  ignorePatterns: [
    'node_modules/',
    'node-v24.16.0-win-x64/',
    'tmp/uploads/',
    'exports/',
    'upravy/',
    'úpravy/'
  ],
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-console': 'off'
  },
  overrides: [
    {
      files: ['tests/**/*.js'],
      env: {
        node: true
      }
    }
  ]
};
