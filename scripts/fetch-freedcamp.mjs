#!/usr/bin/env node
/**
 * fetch-freedcamp.mjs — Standalone Freedcamp data fetcher.
 * Used by the morning skill to pull the current task context.
 *
 * Usage:    node scripts/fetch-freedcamp.mjs
 * Output:   Formatted Freedcamp context (stdout)
 * Exit 1:   API or credential error
 */

import 'dotenv/config';
import { getFreedcampContext } from '../freedcamp.mjs';

try {
  const context = await getFreedcampContext();
  console.log(context);
} catch (err) {
  console.error(`Freedcamp error: ${err.message}`);
  process.exit(1);
}
