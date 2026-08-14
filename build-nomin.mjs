import * as rollup from "rollup";
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

/** Build language: "zh" (default) or "en". Baked into the bundle as SESSION_LANG. */
const buildLang = process.env.CODEXDECK_LANG === "en" ? "en" : "zh";

console.log("stage: imports loaded");

const inputOptions = {
	input: "src/plugin.ts",
	plugins: [
		typescript({ mapRoot: undefined }),
		{
			name: "inline-build-lang",
			transform(code) {
				if (!code.includes('"__CODEXDECK_LANG__"')) {
					return null;
				}
				return { code: code.split('"__CODEXDECK_LANG__"').join(JSON.stringify(buildLang)), map: null };
			}
		},
		nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
		commonjs(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		}
	],
	external: [/bufferutil/, /utf-8-validate/]
};

console.log("stage: calling rollup.rollup()");
const bundle = await rollup.rollup(inputOptions);
console.log("stage: bundle created");
await bundle.write({ file: "com.codexdeck.sdPlugin/bin/plugin.js" });
console.log("stage: written");
await bundle.close();
console.log("done");
