/**
 * Runtime resolver for the @core/* and @modules/* tsconfig path aliases.
 * Used by `npm run start:prod` so compiled code in dist/ can resolve
 * aliases without the TypeScript compiler.
 */
const tsConfigPaths = require('tsconfig-paths');
const path = require('path');

tsConfigPaths.register({
  baseUrl: path.join(__dirname, 'dist'),
  paths: {
    '@core/*': ['core/*'],
    '@modules/*': ['modules/*'],
  },
});
