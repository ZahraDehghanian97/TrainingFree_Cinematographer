const fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
const root = path.resolve(__dirname,"..");let files=0,errors=0;
function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
 const name=path.join(dir,item.name);if(item.isDirectory())walk(name);
 else if(name.endsWith(".ts")&&!name.endsWith(".d.ts")){
  const source=ts.createSourceFile(name,fs.readFileSync(name,"utf8"),ts.ScriptTarget.Latest,true);files++;
  for(const diagnostic of source.parseDiagnostics){errors++;console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText,"\n"),name);}
 }
}}
for(const dir of ["src","scripts","tests","web/src"])walk(path.join(root,dir));
console.log(`${files} TypeScript files parsed; ${errors} syntax errors (not a full dependency-aware typecheck).`);
process.exitCode=errors?1:0;
