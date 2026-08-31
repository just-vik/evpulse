/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/apps/api/test/**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/apps/api/tsconfig.json',
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/apps/api/src/$1',
  },
  // Resolve modules from api app directory first (for its local deps), then root
  modulePaths: [
    '<rootDir>/apps/api/node_modules',
    '<rootDir>/node_modules',
  ],
  testEnvironment: 'node',
};
