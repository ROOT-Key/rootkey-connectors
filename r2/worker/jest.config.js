/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/src/**/*.test.ts"],
  collectCoverage: true,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
  ],
  coverageReporters: ["text", "lcov", "json-summary"],
  coverageThreshold: {
    global: {
      lines: 85,
      functions: 85,
      branches: 75,
      statements: 85,
    },
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: false, tsconfig: { module: "commonjs" } }],
  },
};
