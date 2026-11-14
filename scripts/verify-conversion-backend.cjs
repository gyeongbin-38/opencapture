const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const mainPath = path.join(root, "src/main/openCapture.ts");
const typesPath = path.join(root, "lib/openCaptureTypes.ts");
const preloadPath = path.join(root, "src/preload/dashboard.ts");
const mainText = fs.readFileSync(mainPath, "utf8");
const typesText = fs.readFileSync(typesPath, "utf8");
const preloadText = fs.readFileSync(preloadPath, "utf8");
const mainSource = ts.createSourceFile(
    mainPath,
    mainText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);
const typesSource = ts.createSourceFile(
    typesPath,
    typesText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
);

const visit = (node, predicate) => {
    if (predicate(node)) return node;
    let found;
    ts.forEachChild(node, (child) => {
        if (!found) found = visit(child, predicate);
    });
    return found;
};

const initializer = (name) => {
    const declaration = visit(
        mainSource,
        (node) =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name,
    );
    assert.ok(declaration?.initializer, `Missing production helper: ${name}`);
    return declaration.initializer.getText(mainSource);
};

const ipcHandler = (channel) => {
    const call = visit(mainSource, (node) => {
        if (!ts.isCallExpression(node) || node.arguments.length < 2)
            return false;
        const target = node.expression;
        return (
            ts.isPropertyAccessExpression(target) &&
            target.expression.getText(mainSource) === "ipcMain" &&
            target.name.text === "handle" &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === channel
        );
    });
    assert.ok(call, `Missing IPC handler: ${channel}`);
    return call.arguments[1].getText(mainSource);
};

const run = (source) => {
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, {
        module,
        exports: module.exports,
        require,
        Buffer,
        ArrayBuffer,
        Uint8Array,
        console,
        process,
    });
    return module.exports;
};

const interfaceMembers = (name) => {
    const declaration = visit(
        typesSource,
        (node) => ts.isInterfaceDeclaration(node) && node.name.text === name,
    );
    assert.ok(declaration, `Missing shared interface: ${name}`);
    return new Set(
        declaration.members
            .map((member) => member.name)
            .filter(Boolean)
            .map((member) =>
                member.getText(typesSource).replaceAll(/['"]/g, ""),
            ),
    );
};

for (const [name, members] of [
    ["CaptureConvertOutput", ["path", "bytes", "width", "height"]],
    [
        "CaptureConvertPreview",
        [
            "data",
            "previewMime",
            "exportMime",
            "outputBytes",
            "width",
            "height",
            "approximate",
        ],
    ],
    ["CaptureRegistrationOutcome", ["path", "status", "itemId", "error"]],
    ["CaptureDragAcknowledgement", ["started", "error"]],
]) {
    const actual = interfaceMembers(name);
    for (const member of members)
        assert.ok(actual.has(member), `${name}.${member} is missing`);
}
for (const channel of [
    "oc:items:preview",
    "oc:paths:preview",
    "oc:converted:register",
    "oc:converted:drag",
])
    assert.ok(preloadText.includes(`ipcRenderer.invoke("${channel}"`), channel);

const itemFileHandler = ipcHandler("oc:item-file");
const shelfRead = run(`
const assertRole = (event) => event.sender.role;
const items = new Map([
    ["temporary", { id: "temporary", path: "temporary.webp", status: "temporary" }],
    ["library", { id: "library", path: "library.webp", status: "library" }],
]);
const getItem = (id) => items.get(id);
const shelfItem = (id) => {
    const item = getItem(id);
    if (!item || item.status !== "temporary") throw new Error("Shelf actions require a temporary capture.");
    return item;
};
const statSync = () => ({ size: 12 });
const readFileSync = (value) => Buffer.from(value);
const handler = ${itemFileHandler};
const authorized = handler({ sender: { role: "shelf" } }, "temporary");
let denied = false;
try { handler({ sender: { role: "shelf" } }, "library"); } catch { denied = true; }
module.exports = { authorized: authorized.toString(), denied };
`);
assert.equal(shelfRead.authorized, "temporary.webp");
assert.equal(shelfRead.denied, true);

const previewItemHandler = ipcHandler("oc:items:preview");
const shelfPreview = run(`
const assertRole = (event) => event.sender.role;
const shelfItem = (id) => {
    if (id !== "temporary") throw new Error("Shelf actions require a temporary capture.");
    return { id, path: "temporary.webp" };
};
const getItem = () => { throw new Error("Dashboard only"); };
const parseConvertArgs = () => ({ format: "webp", data: Buffer.from("encoded"), options: { encodedSize: { width: 10, height: 10 } } });
const existsSync = () => true;
const previewConverted = (_path, format, data, options) => ({ format, bytes: data.length, size: options.encodedSize });
const handler = ${previewItemHandler};
const authorized = handler({ sender: { role: "shelf" } }, { id: "temporary" });
let denied = false;
try { handler({ sender: { role: "shelf" } }, { id: "foreign" }); } catch { denied = true; }
module.exports = { authorized, denied };
`);
assert.equal(shelfPreview.authorized.format, "webp");
assert.deepEqual(
    { ...shelfPreview.authorized.size },
    { width: 10, height: 10 },
);
assert.equal(shelfPreview.denied, true);

const registerRenderer = initializer("registerRenderer");
const ownership = run(`
const { EventEmitter } = require("node:events");
const renderers = new Map();
const root = "app";
const isTrustedPage = () => true;
const registerRenderer = ${registerRenderer};
const fake = new EventEmitter();
fake.id = 17;
fake.mainFrame = { url: "file:///app/out/renderer/dashboard.html" };
registerRenderer(fake, "dashboard");
renderers.get(17).exportedPaths.add("owned");
fake.emit("did-start-navigation", {}, fake.mainFrame.url, false, true);
const clearedOnNavigation = renderers.get(17).exportedPaths.size === 0;
renderers.get(17).exportedPaths.add("owned-again");
fake.emit("destroyed");
module.exports = { clearedOnNavigation, clearedOnDestroy: !renderers.has(17) };
`);
assert.equal(ownership.clearedOnNavigation, true);
assert.equal(ownership.clearedOnDestroy, true);

const registrationHandler = ipcHandler("oc:converted:register");
const registration = run(`
const { isAbsolute, extname, resolve } = require("node:path");
const owned = new Set(Array.from({ length: 201 }, (_, index) => resolve("conversion-fixture", index + ".png")));
const renderers = new Map([[1, { exportedPaths: owned }], [2, { exportedPaths: new Set() }]]);
const library = { items: [] };
const assertRole = () => "dashboard";
const pathKey = (value) => value.toLowerCase();
const existsSync = () => true;
const nativeImage = { createFromPath: () => ({ isEmpty: () => false }) };
const findDuplicate = () => undefined;
let sequence = 0;
const remember = (value) => {
    library.items.unshift({ id: "item-" + sequence++, path: value });
    return true;
};
const handler = ${registrationHandler};
const requested = Array.from({ length: 201 }, (_, index) => resolve("conversion-fixture", index + ".png"));
const ordered = handler({ sender: { id: 1 } }, requested);
const denied = handler({ sender: { id: 2 } }, [requested[0]]);
module.exports = { ordered, denied, itemCount: library.items.length, requested };
`);
assert.equal(registration.ordered.length, 201);
assert.equal(registration.itemCount, 201);
assert.deepEqual(
    Array.from(registration.ordered, (entry) => entry.path),
    Array.from(registration.requested),
);
assert.ok(registration.ordered.every((entry) => entry.status === "registered"));
assert.equal(registration.denied[0].status, "failed");

const writeConverted = initializer("writeConverted");
const cap = run(`
const { basename, dirname, extname, resolve } = require("node:path");
const MAX_OWNED_EXPORTS = 1000;
const renderers = new Map([[1, { exportedPaths: new Set(Array.from({ length: 1000 }, (_, i) => String(i))) }]]);
let prepareCalls = 0;
let writeCalls = 0;
const prepareConvertOutput = () => { prepareCalls++; return { output: Buffer.from("x"), size: { width: 1, height: 1 } }; };
const resolveNamePattern = () => "result";
const uniqueExportPath = () => "C:/exports/result.png";
const writeFileSync = () => { writeCalls++; };
const writeConverted = ${writeConverted};
let error = "";
try { writeConverted({ sender: { id: 1 } }, "C:/source.png", "png", undefined, {}); }
catch (caught) { error = caught.message; }
module.exports = { prepareCalls, writeCalls, error };
`);
assert.equal(cap.prepareCalls, 0);
assert.equal(cap.writeCalls, 0);
assert.match(cap.error, /1,000/);

const hasEncodedSignature = initializer("hasEncodedSignature");
const isValidEncodedSize = initializer("isValidEncodedSize");
const inspectWebP = initializer("inspectWebP");
const readIsoBoxes = initializer("readIsoBoxes");
const readSizedUInt = initializer("readSizedUInt");
const isValidAvifContainer = initializer("isValidAvifContainer");
const convertData = initializer("convertData");
const prepareConvertOutput = initializer("prepareConvertOutput");
const formats = run(`
const isValidEncodedSize = ${isValidEncodedSize};
const inspectWebP = ${inspectWebP};
const readIsoBoxes = ${readIsoBoxes};
const readSizedUInt = ${readSizedUInt};
const isValidAvifContainer = ${isValidAvifContainer};
const convertData = ${convertData};
const hasEncodedSignature = ${hasEncodedSignature};
let preparedCount = 0;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mQAAAABJRU5ErkJggg==", "base64");
const headerOnlyPng = Buffer.from([137,80,78,71,13,10,26,10]);
const webp = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=", "base64");
const vp8xOnly = Buffer.alloc(30);
vp8xOnly.write("RIFF", 0, "ascii"); vp8xOnly.writeUInt32LE(22, 4); vp8xOnly.write("WEBP", 8, "ascii");
vp8xOnly.write("VP8X", 12, "ascii"); vp8xOnly.writeUInt32LE(10, 16); vp8xOnly[24] = 1; vp8xOnly[27] = 1;
const malformedTrailingWebp = Buffer.concat([webp, Buffer.from("JUNK"), Buffer.from([10,0,0,0])]);
malformedTrailingWebp.writeUInt32LE(malformedTrailingWebp.length - 8, 4);
const invalidPartitionWebp = Buffer.from(webp);
invalidPartitionWebp[20] = 0xe0; invalidPartitionWebp[21] = 0xff; invalidPartitionWebp[22] = 0xff;
const mismatchedCanvasWebp = Buffer.concat([Buffer.alloc(12), vp8xOnly.subarray(12), webp.subarray(12)]);
mismatchedCanvasWebp.write("RIFF", 0, "ascii"); mismatchedCanvasWebp.writeUInt32LE(mismatchedCanvasWebp.length - 8, 4); mismatchedCanvasWebp.write("WEBP", 8, "ascii");
mismatchedCanvasWebp[24] = 2; mismatchedCanvasWebp[27] = 1;
const headerOnlyWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
const avif = Buffer.from("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAAEAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGAz/2wCAMhMYAAAAUAAAAACpjmy2qrHGtoVA", "base64");
const emptyAvif = Buffer.alloc(33);
emptyAvif.writeUInt32BE(16, 0); emptyAvif.write("ftyp", 4, "ascii"); emptyAvif.write("avif", 8, "ascii"); emptyAvif.write("avif", 12, "ascii");
emptyAvif.writeUInt32BE(8, 16); emptyAvif.write("meta", 20, "ascii");
emptyAvif.writeUInt32BE(9, 24); emptyAvif.write("mdat", 28, "ascii"); emptyAvif[32] = 1;
const outOfRangeAvif = Buffer.from(avif);
const extentMarker = outOfRangeAvif.indexOf(Buffer.from([0,0,1,0x21,0,0,0,0x1d]));
if (extentMarker < 0) throw new Error("Real AVIF extent marker was not found");
outOfRangeAvif.writeUInt32BE(outOfRangeAvif.length + 32, extentMarker);
const decoded = { isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }) };
const intermediate = { isEmpty: () => false, getSize: () => ({ width: 80, height: 40 }) };
const prepared = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) };
const empty = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) };
const nativeImage = { createFromPath: () => decoded, createFromBuffer: (bytes) => bytes[0] === 137 ? (bytes.length > 8 ? intermediate : empty) : bytes.toString("ascii").includes("avif") ? empty : decoded };
const prepareConverted = () => { preparedCount++; return prepared; };
const encodeConverted = (_image, format) => format === "png" ? png : webp;
const prepareConvertOutput = ${prepareConvertOutput};
const finalWebp = prepareConvertOutput("C:/source.svg", "webp", webp, { encodedSize: { width: 2, height: 2 } });
const finalWebpFromPng = prepareConvertOutput("C:/source.png", "webp", webp, { encodedSize: { width: 2, height: 2 } });
const finalAvif = prepareConvertOutput("C:/source.avif", "avif", avif, { encodedSize: { width: 16, height: 16 } });
const fromPng = prepareConvertOutput("C:/source.png", "png", png, { pngData: true });
let mismatch = false;
try { prepareConvertOutput("C:/source.svg", "webp", webp, { encodedSize: { width: 3, height: 2 } }); }
catch { mismatch = true; }
let corruptPngRejected = false;
try { prepareConvertOutput("C:/source.png", "png", headerOnlyPng, { encodedSize: { width: 1, height: 1 } }); }
catch { corruptPngRejected = true; }
module.exports = {
    webpSignature: hasEncodedSignature(webp, "webp"),
    wrongSignature: hasEncodedSignature(headerOnlyWebp, "webp"),
    vp8xOnlyRejected: !hasEncodedSignature(vp8xOnly, "webp"),
    malformedTrailingWebpRejected: !hasEncodedSignature(malformedTrailingWebp, "webp"),
    invalidPartitionWebpRejected: !hasEncodedSignature(invalidPartitionWebp, "webp"),
    mismatchedCanvasWebpRejected: !hasEncodedSignature(mismatchedCanvasWebp, "webp"),
    avifSignature: hasEncodedSignature(avif, "avif"),
    emptyAvifRejected: !hasEncodedSignature(emptyAvif, "avif"),
    outOfRangeAvifRejected: !hasEncodedSignature(outOfRangeAvif, "avif"),
    invalidSize: isValidEncodedSize({ width: 0, height: 20 }),
    finalSize: finalWebp.size,
    pngSourceWebpSize: finalWebpFromPng.size,
    avifSize: finalAvif.size,
    avifUsesRawPreview: !finalAvif.displayImage,
    pngSize: fromPng.size,
    preparedCount,
    mismatch,
    corruptPngRejected,
};
`);
assert.equal(formats.webpSignature, true);
assert.equal(formats.wrongSignature, false);
assert.equal(formats.vp8xOnlyRejected, true);
assert.equal(formats.malformedTrailingWebpRejected, true);
assert.equal(formats.invalidPartitionWebpRejected, true);
assert.equal(formats.mismatchedCanvasWebpRejected, true);
assert.equal(formats.avifSignature, true);
assert.equal(formats.emptyAvifRejected, true);
assert.equal(formats.outOfRangeAvifRejected, true);
assert.equal(formats.invalidSize, false);
assert.deepEqual({ ...formats.finalSize }, { width: 2, height: 2 });
assert.deepEqual({ ...formats.pngSourceWebpSize }, { width: 2, height: 2 });
assert.deepEqual({ ...formats.avifSize }, { width: 16, height: 16 });
assert.equal(formats.avifUsesRawPreview, true);
assert.deepEqual({ ...formats.pngSize }, { width: 1, height: 1 });
assert.equal(formats.preparedCount, 1);
assert.equal(formats.mismatch, true);
assert.equal(formats.corruptPngRejected, true);

const previewConverted = initializer("previewConverted");
assert.equal(previewConverted.includes("writeFileSync"), false);
const preview = run(`
let prepareCalls = 0;
const prepareConvertOutput = (_source, format) => {
    prepareCalls++;
    return {
        output: Buffer.from(format === "pdf" ? "%PDF-test" : "png-output"),
        size: { width: 120, height: 80 },
        displayImage: format === "avif" ? undefined : { isEmpty: () => false, toPNG: () => Buffer.from("display-png") },
    };
};
const exportMime = (format) => format === "pdf" ? "application/pdf" : "image/" + format;
const previewConverted = ${previewConverted};
const png = previewConverted("C:/source.png", "png", undefined, {});
const pdf = previewConverted("C:/source.png", "pdf", undefined, {});
const avif = previewConverted("C:/source.avif", "avif", undefined, {});
module.exports = { png, pdf, avif, prepareCalls };
`);
assert.equal(preview.prepareCalls, 3);
assert.equal(preview.png.previewMime, "image/png");
assert.equal(preview.png.approximate, false);
assert.equal(preview.pdf.previewMime, "image/png");
assert.equal(preview.pdf.exportMime, "application/pdf");
assert.equal(preview.pdf.outputBytes, 9);
assert.equal(preview.pdf.approximate, true);
assert.equal(preview.avif.previewMime, "image/avif");
assert.equal(preview.avif.approximate, false);

console.log(
    JSON.stringify({
        ok: true,
        contracts: 4,
        shelfSourceRead: shelfRead.denied && shelfPreview.denied,
        registrationOutputs: registration.ordered.length,
        ownership: ownership,
        capRejectedBeforePrepareAndWrite: true,
        formatValidation: true,
        strictContainers: {
            realWebp: formats.webpSignature,
            vp8xOnlyRejected: formats.vp8xOnlyRejected,
            malformedTrailingWebpRejected:
                formats.malformedTrailingWebpRejected,
            mismatchedCanvasWebpRejected: formats.mismatchedCanvasWebpRejected,
            realAvif: formats.avifSignature,
            emptyAvifRejected: formats.emptyAvifRejected,
            outOfRangeAvifRejected: formats.outOfRangeAvifRejected,
        },
        previewWrites: 0,
    }),
);
