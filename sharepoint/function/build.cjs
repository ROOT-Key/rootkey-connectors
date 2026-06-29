/* eslint-disable */
// Post-process the esbuild output so the deployed package is what the Azure
// Functions Node.js v4 worker expects:
//
//   dist/
//   ├── host.json
//   ├── package.json   (main = "src/index.js", deps include @azure/functions)
//   ├── src/index.js   (the esbuild bundle, with @azure/functions external)
//   └── node_modules/
//       └── @azure/functions/   (installed by `npm install` below)
//
// The reason @azure/functions can NOT be bundled: its programmatic registration
// API (`app.http()`, `app.timer()`, etc.) talks to the worker host through an
// IPC channel set up by the worker's own copy of @azure/functions-core. When
// the SDK is bundled, those calls land on an isolated in-bundle instance that
// never reaches the host — the result is the host reporting "0 functions
// found (Custom)" even though our code did call the registration helpers.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const distDir = path.join(__dirname, "dist");

// 1) Copy host.json so the runtime finds the host configuration.
fs.copyFileSync(path.join(__dirname, "host.json"), path.join(distDir, "host.json"));

// 2) Write a minimal package.json. `main` is relative to the zip root (which is
//    dist/ after Terraform archives it). Only @azure/functions needs to live in
//    node_modules — everything else is bundled inside src/index.js.
const sourcePkg = require("./package.json");
const distPkg = {
  name: sourcePkg.name,
  version: sourcePkg.version,
  private: true,
  main: "src/index.js",
  dependencies: {
    "@azure/functions": sourcePkg.dependencies["@azure/functions"],
  },
};
fs.writeFileSync(
  path.join(distDir, "package.json"),
  JSON.stringify(distPkg, null, 2) + "\n",
);

// 3) Install the minimal runtime dependency tree inside dist/. Using --no-package-lock
//    keeps the install reproducible from the version range we just wrote.
execSync("npm install --omit=dev --no-package-lock --no-audit --no-fund --silent", {
  cwd: distDir,
  stdio: "inherit",
});
