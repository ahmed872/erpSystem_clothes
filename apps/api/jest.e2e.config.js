/** E2E/integration tests: real NestJS app + real PostgreSQL (erp_test), no mocks. */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  setupFiles: ['<rootDir>/test/jest-e2e.setup.ts'],
  testTimeout: 30000,
};
