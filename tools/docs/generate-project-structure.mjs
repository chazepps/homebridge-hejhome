#!/usr/bin/env node
import {
  GENERATED_MARKER,
  listProjectFiles,
  renderTree,
  writeIfChanged,
  readText,
  exists,
} from './harness-lib.mjs';

const checkOnly = process.argv.includes('--check');

const outputs = new Map([
  ['docs/generated/project-structure/README.md', renderIndex()],
  ['docs/generated/project-structure/monorepo.md', renderMonorepo()],
]);

const changed = [];
for (const [relativePath, content] of outputs) {
  if (checkOnly) {
    if (!exists(relativePath) || readText(relativePath) !== content) {
      changed.push(relativePath);
    }
  } else if (writeIfChanged(relativePath, content)) {
    changed.push(relativePath);
  }
}

if (checkOnly && changed.length > 0) {
  console.error('generated project structure is stale:');
  for (const relativePath of changed) {
    console.error(`- ${relativePath}`);
  }
  process.exit(1);
}

console.log(checkOnly
  ? 'generated project structure is current'
  : `generated project structure (${changed.length} file(s) changed)`);

function renderIndex() {
  return `${GENERATED_MARKER}
# Project Structure Snapshot

This directory is generated from the repository file tree. Do not edit these files by hand.

## Files

- \`monorepo.md\` - current source tree snapshot excluding dependencies, build output, reports, and archived backup code.
`;
}

function renderMonorepo() {
  const tree = renderTree(listProjectFiles().filter((relativePath) => {
    return !relativePath.startsWith('docs/generated/project-structure/');
  }));
  return `${GENERATED_MARKER}
# Repository Structure

Generated from the current repository tree. The archived \`backup/\` directory and generated project-structure snapshots are intentionally excluded.

\`\`\`text
${tree}\`\`\`
`;
}
