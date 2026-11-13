#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const projectName = process.argv[2];

if (!projectName) {
  console.error('\x1b[31mPlease specify the project directory:\x1b[0m');
  console.error('  npx create-vulajs-app <project-directory>');
  process.exit(1);
}

const targetDir = path.join(process.cwd(), projectName);

if (fs.existsSync(targetDir)) {
  console.error(`\x1b[31mDirectory ${projectName} already exists.\x1b[0m`);
  process.exit(1);
}

const templateDir = path.join(__dirname, '../template');

console.log(`\x1b[36mCreating a new Vula.js app in ${targetDir}...\x1b[0m`);

// Copy template files
fs.cpSync(templateDir, targetDir, { recursive: true });

// Update package.json name
const packageJsonPath = path.join(targetDir, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.name = projectName;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

console.log('\x1b[32mSuccess! Created', projectName, '\x1b[0m');
console.log('Inside that directory, you can run several commands:\n');
console.log('  \x1b[36mnpm install\x1b[0m');
console.log('    Installs dependencies.\n');
console.log('  \x1b[36mnpm run dev\x1b[0m');
console.log('    Starts the development server.\n');
console.log('We suggest that you begin by typing:\n');
console.log(`  \x1b[36mcd ${projectName}\x1b[0m`);
console.log('  \x1b[36mnpm install\x1b[0m');
console.log('  \x1b[36mnpm run dev\x1b[0m');
