const {spawn}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const profile=path.join(root,'.evidence/packaged-profile');fs.mkdirSync(profile,{recursive:true});
const models=path.join(root,'.omx/smoke-models-phase0');
if(fs.existsSync(models))fs.cpSync(models,path.join(profile,'translation/models'),{recursive:true});
const exe=path.join(root,'release/win-unpacked/OpenCapture.exe');
const child=spawn(exe,['--remote-debugging-port=0',`--userData=${profile}`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let socket;let id=0;const pending=new Map();let log='';child.stderr.on('data',d=>{log+=d.toString()});
const call=(method,params={})=>new Promise((resolve,reject)=>{const request=++id;pending.set(request,{resolve,reject});socket.send(JSON.stringify({id:request,method,params}))});
const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
const timer=setTimeout(()=>{console.error('Package test timed out',log);child.kill();process.exit(1)},60000);
(async()=>{try{
let page;for(let i=0;i<100;i++){try{const port=log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];if(!port)throw Error('Waiting for debugger');const pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();page=pages.find(p=>p.url.includes('dashboard.html'));if(page)break}catch{}await new Promise(r=>setTimeout(r,250))}
if(!page)throw Error('Packaged dashboard missing: '+log);
socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
socket.onmessage=e=>{const msg=JSON.parse(e.data);if(!msg.id)return;const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result)}};
for(let i=0;i<100;i++){try{if(await evaluate("typeof window.openCapture === 'object'"))break}catch{}await new Promise(r=>setTimeout(r,50))}
const state=await evaluate('window.openCapture.getState()');
const status=await evaluate('window.openCapture.translationStatus()');
const translation=await evaluate('window.openCapture.translate({texts:["Hello, how are you?"],from:"en",to:"ko",engine:"local"})');
const isolation=await evaluate('({require:typeof require,bridge:typeof window.openCapture})');
const screenshot=await call('Page.captureScreenshot');fs.writeFileSync(path.join(root,'.evidence/packaged-dashboard.png'),Buffer.from(screenshot.data,'base64'));
const evidence={exe,version:state.version,status,translation,isolation};fs.writeFileSync(path.join(root,'.evidence/package.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
if(!status.runtimeReady||!status.modelsReady||!translation[0]||isolation.require!=='undefined')throw Error('Package verification failed');
}catch(e){console.error(e);process.exitCode=1}finally{clearTimeout(timer);socket?.close();child.kill()}})();
