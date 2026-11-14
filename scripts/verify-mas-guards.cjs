const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
function parse(relative) {
    const file = path.join(root, relative);
    return ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

function find(ast, predicate, label) {
    const matches = [];
    const visit = (node) => {
        if (predicate(node)) matches.push(node);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.equal(matches.length, 1, `Expected one production ${label}`);
    return matches[0];
}

function variable(ast, name) {
    return find(
        ast,
        (node) =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name,
        name,
    ).initializer;
}

function evaluate(source, globals = {}, setup = "") {
    const module = { exports: {} };
    const compiled = ts.transpileModule(
        `${setup}\nmodule.exports = (${source});`,
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        },
    ).outputText;
    vm.runInNewContext(compiled, Object.assign(globals, { module }), {
        timeout: 1_000,
    });
    return module.exports;
}

async function verifyMasGuards() {
    const main = parse("src/main/main.ts");
    const ding = parse("src/renderer/ding/ding.ts");
    const checks = [];
    const forbidden = (operation) => () => {
        throw new Error(`MAS invoked ${operation}`);
    };
    const declaration = (name) =>
        find(
            main,
            (node) =>
                ts.isFunctionDeclaration(node) && node.name?.text === name,
            name,
        ).getText(main);
    const mas = { mas: true, platform: "darwin", pid: 100 };
    const copyText = evaluate(declaration("copyText"), {
        process: mas,
        clipboard: { readText: forbidden("clipboard automation") },
        exec: forbidden("Apple Events"),
        require: forbidden("native input"),
        setTimeout: forbidden("clipboard timer"),
    });
    let copied;
    await copyText((value) => {
        copied = value;
    });
    assert.equal(copied, "");
    checks.push(
        "selected-text automation returns before clipboard, Apple Events and native input",
    );

    const mouseState = {
        process: mas,
        mouseHookFailed: false,
        mouseChordRun: forbidden("mouse chord"),
        require: forbidden("global input"),
    };
    evaluate(declaration("syncMouseChord"), mouseState)();
    assert.equal(mouseState.mouseHookFailed, true);
    checks.push("global mouse hook stops before loading native input");
    const step = evaluate(declaration("toggleStepCapture"), {
        process: mas,
        t: () => "MAS_UNSUPPORTED",
    });
    assert.throws(() => step(), /MAS_UNSUPPORTED/);
    checks.push("step capture cannot enable global input");

    let nativeLoads = 0;
    const native = {
        Window: {
            all: () => [
                {
                    isFocused: () => true,
                    appName: () => "Fixture",
                    pid: () => 101,
                },
            ],
        },
    };
    const focus = variable(ding, "focusedApp").getText(ding);
    const blockedFocus = evaluate(
        focus,
        {
            process: mas,
            require: () => {
                nativeLoads++;
                return native;
            },
        },
        "let NodeScreenshots;",
    );
    assert.equal(blockedFocus(), null);
    assert.equal(nativeLoads, 0, "MAS focus tracking loaded node-screenshots");
    const normalFocus = evaluate(
        focus,
        {
            process: { ...mas, mas: false },
            require: () => {
                nativeLoads++;
                return native;
            },
        },
        "let NodeScreenshots;",
    );
    assert.equal(normalFocus().app, "Fixture");
    assert.equal(normalFocus().pid, 101);
    assert.equal(
        nativeLoads,
        1,
        "Normal builds must retain lazy cached focus lookup",
    );
    checks.push(
        "application focus lookup is blocked in MAS and retained lazily elsewhere",
    );

    const link = variable(ding, "linkButton");
    const handler = find(
        link,
        (node) =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "on" &&
            node.arguments[0]?.getText(ding) === '"click"',
        "link click handler",
    ).arguments[1];
    const blockedLink = evaluate(handler.getText(ding), {
        process: mas,
        setInterval: forbidden("focus timer"),
    });
    blockedLink();
    checks.push("application link handler stops before starting a focus timer");
    for (const enabled of [false, true]) {
        const actions = evaluate(
            variable(ding, "radialActions").getText(ding),
            {
                process: { ...mas, mas: !enabled },
                t: (value) => value,
                undoCutout: forbidden("cutout"),
            },
        );
        assert.equal(
            actions.filter((action) => action.icon === "link").length,
            enabled ? 1 : 0,
        );
    }
    checks.push(
        "application link action is absent from MAS menus and retained elsewhere",
    );

    const crash = find(
        main,
        (node) =>
            ts.isIfStatement(node) &&
            node.expression.getText(main) === "!process.mas" &&
            node.thenStatement.getText(main).includes("crashReporter.start"),
        "crash reporter guard",
    );
    for (const enabled of [false, true]) {
        let starts = 0;
        evaluate(`() => { ${crash.getText(main)} }`, {
            process: { mas: !enabled },
            crashReporter: {
                start: () => {
                    starts++;
                },
            },
        })();
        assert.equal(starts, enabled ? 1 : 0);
    }
    checks.push("crash reporter is disabled in MAS and retained elsewhere");
    return {
        ok: true,
        scope: "Production TypeScript in isolated JavaScript contexts; no macOS or App Sandbox runtime emulation",
        checks,
    };
}

module.exports = { verifyMasGuards };
if (require.main === module)
    verifyMasGuards()
        .then((report) => console.log(JSON.stringify(report, null, 2)))
        .catch((error) => {
            console.error(error.stack || error.message);
            process.exitCode = 1;
        });
