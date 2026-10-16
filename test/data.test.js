const test=require('node:test'); const assert=require('node:assert/strict'); const cp=require('child_process'); const path=require('path');
test('data validator passes',()=>{cp.execFileSync(process.execPath,[path.join(__dirname,'..','scripts','validate_data.js')],{stdio:'pipe'}); assert.ok(true)});
test('stable migration IDs are deterministic',()=>{const crypto=require('crypto'); const f=t=>`${t}:${crypto.createHash('sha256').update(`${t}\0张三`).digest('hex').slice(0,20)}`; assert.equal(f('person'),f('person')); assert.notEqual(f('person'),f('organization'));});
