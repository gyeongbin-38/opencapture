const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'.evidence'),{recursive:true});
const errors=[];
app.on('web-contents-created',(_,wc)=>{wc.on('console-message',(_,level,message)=>{if(level>=3)errors.push(message)});wc.on('render-process-gone',(_,d)=>errors.push(JSON.stringify(d)))});
require('../out/main/main.js');
const timer=setTimeout(()=>{console.error('SMOKE TIMEOUT');app.exit(1)},180000);
app.whenReady().then(async()=>{
try{
let win;
for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('dashboard.html'));if(win&&!win.webContents.isLoading())break;await new Promise(r=>setTimeout(r,200))}
if(!win)throw Error('Dashboard missing');
await new Promise(r=>setTimeout(r,1200));
const state=await win.webContents.executeJavaScript('window.openCapture.getState()');
const status=await win.webContents.executeJavaScript('window.openCapture.translationStatus()');
if(process.argv.includes('--integration') || process.argv.includes('--translation')) {
 const installed=await win.webContents.executeJavaScript('window.openCapture.installModels()');
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
 const translation=await win.webContents.executeJavaScript('window.openCapture.translate({texts:["Hello, how are you?"],from:"en",to:"ko",engine:"local"})');
 if(!translation[0]||translation[0]==='Hello, how are you?')throw Error('Offline translation failed');
 fs.writeFileSync(path.join(root,'.evidence/translation.json'),JSON.stringify({installed,translation,networkBlocked:true},null,2));
 if(process.argv.includes('--integration')) {
 await win.webContents.executeJavaScript('window.openCapture.action("fullscreen")');
 await new Promise(r=>setTimeout(r,1500));
 const captureState=await win.webContents.executeJavaScript('window.openCapture.getState()');
 if(!captureState.items.length)throw Error('Capture was not indexed');
 const saved=captureState.items[0];
 const size=require('electron').nativeImage.createFromPath(saved.path).getSize();
 const bitmap=require('electron').nativeImage.createFromPath(saved.path).toBitmap();
 let nonBlack=false;for(let i=0;i<bitmap.length;i+=4){if(bitmap[i]||bitmap[i+1]||bitmap[i+2]){nonBlack=true;break}}
 if(size.width<100||size.height<100)throw Error('Capture dimensions invalid');
 fs.writeFileSync(path.join(root,'.evidence/integration.json'),JSON.stringify({installed,translation,capture:{path:saved.path,size,nonBlack,verified:nonBlack}},null,2));
 if(!nonBlack)throw Error('Screen pixels are all black; capture content NOT verified');
 console.log('INTEGRATION',JSON.stringify({translation,size}));
 }
}
win.show();
const ui=await win.webContents.executeJavaScript('({title:document.title,buttons:document.querySelectorAll("button").length,text:document.body.innerText.slice(0,700),bridge:typeof window.openCapture,require:typeof require})');
fs.writeFileSync(path.join(root,'.evidence/dashboard.png'),(await win.webContents.capturePage()).toPNG());
fs.writeFileSync(path.join(root,'.evidence/startup.json'),JSON.stringify({state,status,ui,errors},null,2));
console.log(JSON.stringify({ui,status,errors}));
if(ui.bridge!=='object'||ui.require!=='undefined'||errors.length)throw Error('Startup validation failed');
clearTimeout(timer);app.exit(0);
}catch(e){console.error(e);clearTimeout(timer);app.exit(1)}
});
