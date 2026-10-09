const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');const profile=path.join(root,'.evidence/glass-profile');fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(path.join(root,'.evidence/glass'),{recursive:true});
const child=spawn(path.join(root,'release/win-unpacked/OpenCapture.exe'),['--broker','--toggle','--remote-debugging-port=0',`--userData=${profile}`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let ws,id=0,log='';const pending=new Map();child.stderr.on('data',d=>log+=d);const delay=ms=>new Promise(r=>setTimeout(r,ms));
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
const shots=async name=>{const r=await call('Page.captureScreenshot');fs.writeFileSync(path.join(root,`.evidence/glass/${name}.png`),Buffer.from(r.data,'base64'))};
const timer=setTimeout(()=>{child.kill();console.error('Design QA timeout',log);process.exit(1)},60000);
(async()=>{try{
let page;for(let i=0;i<120;i++){try{const port=log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];if(port)page=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.url.includes('dashboard.html'));if(page)break}catch{}await delay(150)}if(!page)throw Error('No dashboard');
ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}};
for(let i=0;i<100;i++){try{if(await evaluate("Boolean(window.openCapture && document.querySelectorAll('.nav-button').length===4)"))break}catch{}await delay(50)}
const findings=[];
if(await evaluate("getComputedStyle(document.querySelector('.modal-backdrop')).display")!=='none')throw Error('Closed modal scrim obscures workspace');
for(const [i,name] of ['home','library','translate','settings'].entries()){
 await evaluate(`document.querySelectorAll('.nav-button')[${i}].click();window.scrollTo(0,0)`);await delay(300);await shots(name);
 findings.push(await evaluate(`({page:'${name}',width:innerWidth,scrollWidth:document.documentElement.scrollWidth,font:getComputedStyle(document.querySelector('h1')).fontFamily,titleSize:getComputedStyle(document.querySelector('h1')).fontSize,svgCount:document.querySelectorAll('.icon svg').length})`));
}
await evaluate("document.querySelector('.shortcut-button').click()");await delay(180);await shots('shortcuts');
await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',windowsVirtualKeyCode:9});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',windowsVirtualKeyCode:9});
const modalFocus=await evaluate("document.querySelector('.shortcut-dialog').contains(document.activeElement)");if(!modalFocus)throw Error('Dialog focus escaped');findings.push({page:'modal-keyboard',focusContained:modalFocus});
await evaluate("document.querySelector('.dialog-header button').click()");
await evaluate("document.querySelectorAll('.nav-button')[0].click();window.openCapture.action('toggle-compact')");await delay(250);await shots('compact-home');
findings.push(await evaluate("({page:'compact',width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,nav:[...document.querySelectorAll('.nav-button')].map(b=>{const r=b.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}}),welcome:(()=>{const r=document.querySelector('.welcome-card').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}})(),heroButton:(()=>{const r=document.querySelector('.hero-capture-button').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}})(),grid:(()=>{const r=document.querySelector('.action-grid').getBoundingClientRect();return {y:r.y,bottom:r.bottom}})()})"));
await evaluate("document.querySelectorAll('.nav-button')[1].click();window.scrollTo(0,0)");await delay(200);await shots('compact-library');
await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'}]});
findings.push(await evaluate("({page:'reduced-effects',animations:document.getAnimations().length,sidebarBlur:getComputedStyle(document.querySelector('.sidebar')).backdropFilter})"));
if(findings.some(f=>f.scrollWidth>f.width+1))throw Error('Horizontal overflow');
fs.writeFileSync(path.join(root,'.evidence/glass/qa.json'),JSON.stringify(findings,null,2));console.log(JSON.stringify(findings));
}catch(e){console.error(e);process.exitCode=1}finally{clearTimeout(timer);ws?.close();child.kill()}})();
