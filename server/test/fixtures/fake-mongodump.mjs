#!/usr/bin/env node
// Stand-in for mongodump: records how it was called and writes a small "archive".
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('mongodump version: 100.9.4');
  process.exit(0);
}
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return null;
  return args[i].includes('=') ? args[i].slice(name.length + 1) : args[i + 1];
};
const cfg = readFileSync(opt('--config'), 'utf8');
appendFileSync(process.env.FAKE_MONGO_LOG, JSON.stringify({ tool: 'mongodump', args, cfg }) + '\n');
if (cfg.includes('failhost')) {
  console.error('error connecting to host: could not connect to mongodb://admin:hunter2secret@failhost:27017/ : server selection timeout');
  process.exit(1);
}
writeFileSync(opt('--archive'), `DUMP db=${opt('--db') ?? '(all)'}\n`);
