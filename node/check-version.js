const requiredVersion = 18;
const currentVersion = process.versions.node;
const majorVersion = parseInt(currentVersion.split('.')[0], 10);

if (majorVersion < requiredVersion) {
  console.error(`\x1b[31m[vula] Error: Node.js version ${currentVersion} is not supported.\x1b[0m`);
  console.error(`\x1b[31m[vula] Please upgrade to Node.js v${requiredVersion}.0.0 or higher.\x1b[0m`);
  process.exit(1);
}
