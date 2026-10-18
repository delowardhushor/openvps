#!/usr/bin/env node
// Stand-in for mongorestore: records how it was called and what it was asked to restore.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('mongorestore version: 100.9.4');
  process.exit(0);
}
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return null;
  return args[i].includes('=') ? args[i].slice(name.length + 1) : args[i + 1];
};
appendFileSync(
  process.env.FAKE_MONGO_LOG,
  JSON.stringify({ tool: 'mongorestore', args, cfg: readFileSync(opt('--config'), 'utf8'), archive: readFileSync(opt('--archive'), 'utf8') }) + '\n',
);
