const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const root = path.resolve(__dirname, "..");
const timer = setTimeout(() => {
    console.error("OCR timeout");
    app.exit(1);
}, 90000);
app.whenReady().then(async () => {
    try {
        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                sandbox: false,
            },
        });
        await win.loadURL("about:blank");
        const results = await win.webContents.executeJavaScript(`(async()=>{
 const root=${JSON.stringify(root)};const fs=require('node:fs');const p=require('node:path');
 const ocr=require(p.join(root,'node_modules/esearch-ocr'));const ort=require(p.join(root,'node_modules/onnxruntime-node'));
 const results=[];
 for(const [language,text,rec,dic] of [['en','OpenCapture screen capture','ppocr6_small_rec.onnx','dic.txt'],['ko','안녕하세요 화면 캡처','korean/korean_rec.onnx','korean/korean_dict.txt']]){
 const canvas=document.createElement('canvas');canvas.width=900;canvas.height=160;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,900,160);ctx.fillStyle='black';ctx.font='40px "Malgun Gothic", sans-serif';ctx.fillText(text,30,95);
 const base=p.join(root,'assets/onnx/ppocr');const engine=await ocr.init({det:{input:p.join(base,'ppocr6_small_det.onnx'),ratio:1},rec:{input:p.join(base,rec),decodeDic:fs.readFileSync(p.join(base,dic),'utf8')},ort,ortOption:{executionProviders:['cpu'],intraOpNumThreads:2}});
 const output=await engine.ocr(canvas.toDataURL());results.push({language,expected:text,recognized:output.columns.flatMap(c=>c.parragraphs).map(p=>p.parse.text).join(' ')});
 }return results;})()`);
        fs.writeFileSync(
            path.join(root, ".evidence/ocr.json"),
            JSON.stringify(results, null, 2),
        );
        console.log(results);
        const lev = (a, b) => {
            const m = a.length,
                n = b.length,
                d = Array.from({ length: m + 1 }, (_, i) => [
                    i,
                    ...Array(n).fill(0),
                ]);
            for (let j = 1; j <= n; j++) d[0][j] = j;
            for (let i = 1; i <= m; i++)
                for (let j = 1; j <= n; j++)
                    d[i][j] = Math.min(
                        d[i - 1][j] + 1,
                        d[i][j - 1] + 1,
                        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
                    );
            return d[m][n];
        };
        const scored = results.map((r) => {
            const e = r.expected.replaceAll(" ", ""),
                o = r.recognized.replaceAll(" ", "");
            const distance = lev(e, o);
            return { ...r, similarity: 1 - distance / Math.max(e.length, 1) };
        });
        fs.writeFileSync(
            path.join(root, ".evidence/ocr-scored.json"),
            JSON.stringify(scored, null, 2),
        );
        if (!scored.every((r) => r.similarity >= 0.8))
            throw Error(
                `OCR similarity below threshold: ${JSON.stringify(scored.map((r) => ({ language: r.language, similarity: r.similarity })))}`,
            );
        clearTimeout(timer);
        app.exit(0);
    } catch (e) {
        console.error(e);
        clearTimeout(timer);
        app.exit(1);
    }
});
