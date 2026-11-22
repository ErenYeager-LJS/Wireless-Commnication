// A file avoids Windows PowerShell 5.1 stripping quotes from node -e strings.
'use strict';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js 22.13+ required (24 LTS recommended).');
  process.exit(1);
}
require('node:sqlite');
console.log(`Node runtime check passed: ${process.version}`);
