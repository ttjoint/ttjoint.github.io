#!/usr/bin/env node
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..'),db=path.join(root,'local_data');
// Exporting is intentionally delegated to the existing canonical JSON pipeline.
// The admin server writes SQLite; this command currently rebuilds static indexes.
const {execFileSync}=require('child_process');execFileSync(process.execPath,[path.join(__dirname,'build_index.js')],{stdio:'inherit'});console.log('Static indexes rebuilt.');
