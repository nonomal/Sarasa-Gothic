import ChildProcess from "child_process";
import path from "path";

import fs from "fs-extra";
import * as temp from "temp";
import which from "which";

import * as FontIo from "../support/font-io.mjs";

import GetConfig from "./config.mjs";
import * as GlyphClass from "./glyph-class.mjs";
import * as MergeTables from "./merge-tables.mjs";
import * as Rank from "./rank.mjs";
import ReverseGidMap from "./reverse-gid-map.mjs";
import SharedGlyphList from "./shared-glyph-list.mjs";

///////////////////////////////////////////////////////////////////////////////////////////////////

async function collectGlyphs(Config) {
	const fonts = [];
	const glyphs = new SharedGlyphList();
	const shapeHintResolver = new Rank.ShapeHintResolver();
	for (let f of Config.inputs) {
		const font = await FontIo.loadFont(f, { nameByHash: true });
		const fontIndex = fonts.length;
		const rf = new Rank.RankFactory(shapeHintResolver, fontIndex, font);
		const revGidMap = ReverseGidMap(font.glyph_order);
		for (let g in font.glyf) {
			const glyph = font.glyf[g];
			const gIndex = revGidMap.get(g);
			const rank = rf.decideForGlyph(gIndex, g);
			const gk = GlyphClass.decideGlyphClass(
				font.glyf[g],
				gIndex,
				Config.commonWidth,
				Config.commonHeight
			);
			font.glyf[g] = glyphs.add(g, glyph, gk, rank, fontIndex);
		}
		if (global.gc) global.gc();
		fonts.push(font);
	}
	glyphs.addPostSpacePad(fonts.length);
	glyphs.sort();
	for (let fontIndex = 0; fontIndex < fonts.length; fontIndex++) {
		const font = fonts[fontIndex];
		const extracted = glyphs.extract(entry => entry.used.has(fontIndex));
		font.glyf = extracted.glyf;
		font.glyph_order = extracted.glyph_order;
	}
	const shareMap = glyphs.extractShareMap(fonts.length);
	return { fonts, shareMap };
}

///////////////////////////////////////////////////////////////////////////////////////////////////

async function buildOtf(fonts, tempDir, filter) {
	// build OTF
	let buffers = [];
	for (const font of fonts) {
		let pOtf = temp.path({ dir: tempDir, suffix: ".otf" });
		await FontIo.buildFont(font, pOtf, { optimize: true, quiet: true });
		if (filter) {
			const [flCmd, ...flArgs] = filter.split(/ +/g);
			const pOtf1 = temp.path({ dir: tempDir, suffix: ".otf" });
			await FontIo.cpToPromise(
				ChildProcess.spawn(which.sync(flCmd), [...flArgs, pOtf, pOtf1])
			);
			await fs.remove(pOtf);
			pOtf = pOtf1;
		}
		buffers.push(await fs.readFile(pOtf));
		await fs.remove(pOtf);
	}
	return buffers;
}
export default (async function main(_argv) {
	const Config = GetConfig(_argv);
	const tempDir = path.dirname(path.resolve(Config.output));
	await fs.ensureDir(tempDir);
	const sh = await collectGlyphs(Config);
	const buffers = await buildOtf(sh.fonts, tempDir, Config.filterLoop);
	await MergeTables.merge(buffers, Config.output, sh.shareMap);
});
