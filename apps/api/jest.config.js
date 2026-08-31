/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
        strictNullChecks: false,
        noImplicitAny: false,
        skipLibCheck: true,
      },
    }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testEnvironment: 'node',
};
