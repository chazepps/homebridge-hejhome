#!/usr/bin/env node
import fs from 'node:fs';

import {
  GENERATED_MARKER,
  REQUIRED_DOC_PATHS,
  absolutePath,
  exists,
  listMarkdownFiles,
  readText,
  validateForbiddenContent,
  validateMarkdownLinks,
} from './harness-lib.mjs';

const errors = [];

for (const relativePath of REQUIRED_DOC_PATHS) {
  if (!exists(relativePath)) {
    errors.push(`missing required documentation file: ${relativePath}`);
    continue;
  }

  if (fs.statSync(absolutePath(relativePath)).size === 0) {
    errors.push(`empty documentation file: ${relativePath}`);
  }
}

for (const relativePath of listMarkdownFiles()) {
  errors.push(...validateForbiddenContent(relativePath));
  errors.push(...validateMarkdownLinks(relativePath));

  if (relativePath.includes('/generated/project-structure/') && !readText(relativePath).includes(GENERATED_MARKER)) {
    errors.push(`generated file missing marker: ${relativePath}`);
  }
}

if (errors.length > 0) {
  console.error(`documentation harness validation failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`documentation harness validation passed (${listMarkdownFiles().length} markdown files checked)`);
