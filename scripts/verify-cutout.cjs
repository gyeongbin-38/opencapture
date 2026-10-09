const {app,BrowserWindow,nativeImage}=require('electron');const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');
app.whenReady().then(async()=>{try{
const win=new BrowserWindow({show:false});await win.loadURL('about:blank');
const data=await win.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas');c.width=400;c.height=400;const x=c.getContext('2d');x.fillStyle='#eee8d8';x.fillRect(0,0,400,400);x.fillStyle='#e66836';x.beginPath();x.ellipse(200,190,90,120,0,0,Math.PI*2);x.fill();x.fillStyle='#548856';x.fillRect(180,40,40,40);return c.toDataURL()})()`);
const {removeBackground}=require('../.evidence/background.cjs');const output=await removeBackground(nativeImage.createFromDataURL(data),root);const pixels=output.toBitmap();let min=255,max=0;for(let i=3;i<pixels.length;i+=4){min=Math.min(min,pixels[i]);max=Math.max(max,pixels[i])}
fs.writeFileSync(path.join(root,'.evidence/cutout.png'),output.toPNG());fs.writeFileSync(path.join(root,'.evidence/cutout.json'),JSON.stringify({minAlpha:min,maxAlpha:max,size:output.getSize(),fixture:'synthetic shape; not a natural-photo quality benchmark'},null,2));console.log({min,max});app.exit(min<10&&max>240?0:1);
}catch(e){console.error(e);app.exit(1)}});
