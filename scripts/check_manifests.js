#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.join(__dirname,'..');
const dirs=['persons','organizations','events'];let errors=0;
for(const d of dirs){const m=path.join(root,'data',d,'manifest.json');if(!fs.existsSync(m)){console.error('missing manifest',m);errors++;continue}const x=JSON.parse(fs.readFileSync(m));if(!x.version||!x.type||!Number.isInteger(x.count)){console.error('invalid manifest',m);errors++;continue}const file=path.join(root,'data',d,'index.json');const actual=JSON.parse(fs.readFileSync(file));if(actual.length!==x.count){console.error('count mismatch',d,actual.length,x.count);errors++;}const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');console.log(`${d}: ${actual.length} records, sha256 ${hash.slice(0,12)}`)}process.exitCode=errors?1:0;
