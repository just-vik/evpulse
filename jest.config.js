/** @type {import('jest').Config} */
module.exports = {
  testPathIgnorePatterns: ['/node_modules/', '/.next/'],
  watchPathIgnorePatterns: ['/.next/'],
  projects: [
    {
      displayName: 'api',
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
      modulePaths: [
        '<rootDir>/apps/api/node_modules',
        '<rootDir>/node_modules',
      ],
      testEnvironment: 'node',
    },
    {
      displayName: 'web',
      rootDir: '.',
      testMatch: ['<rootDir>/apps/web/src/**/__tests__/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', {
          tsconfig: '<rootDir>/apps/web/tsconfig.json',
          diagnostics: false,
        }],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/apps/web/src/$1',
      },
      modulePaths: [
        '<rootDir>/apps/web/node_modules',
        '<rootDir>/node_modules',
      ],
      testEnvironment: 'node',
    },
  ],
};
