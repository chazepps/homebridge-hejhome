#!/usr/bin/env node
import {
  REQUIRED_DOC_PATHS,
  exists,
  listMarkdownFiles,
  readText,
  validateForbiddenContent,
} from './harness-lib.mjs';

const checkOnly = process.argv.includes('--check');
const errors = [];
const markdownFiles = listMarkdownFiles();

for (const relativePath of REQUIRED_DOC_PATHS) {
  if (!exists(relativePath)) {
    errors.push(`missing required documentation file: ${relativePath}`);
  }
}

for (const command of [
  'node tools/docs/inventory-doc-harness.mjs --check',
  'node tools/docs/validate-doc-harness.mjs',
  'node tools/docs/generate-project-structure.mjs --check',
  'git diff --check',
]) {
  if (!exists('DOCUMENTATION_REFACTORING.md') || !readText('DOCUMENTATION_REFACTORING.md').includes(command)) {
    errors.push(`DOCUMENTATION_REFACTORING.md does not list validation command: ${command}`);
  }
}

for (const relativePath of markdownFiles) {
  errors.push(...validateForbiddenContent(relativePath));
}

if (errors.length > 0) {
  console.error(`documentation inventory check failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (checkOnly) {
  console.log(`documentation inventory check passed (${markdownFiles.length} markdown files)`);
} else {
  console.log(markdownFiles.join('\n'));
}
