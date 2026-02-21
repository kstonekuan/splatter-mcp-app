interface ParsedPlyHeader {
	format: string;
	vertexPropertyNames: Set<string>;
}

const MINIMUM_HEADER_SCAN_BYTES = 64_000;

function parseHeaderLineTokens(headerLine: string): string[] {
	return headerLine
		.trim()
		.split(/\s+/)
		.filter((tokenValue) => tokenValue.length > 0);
}

function parsePlyHeader(plyBytes: Uint8Array): ParsedPlyHeader {
	const decodedHeaderText = new TextDecoder("utf-8").decode(
		plyBytes.slice(0, Math.min(MINIMUM_HEADER_SCAN_BYTES, plyBytes.byteLength)),
	);
	const headerLines = decodedHeaderText.split("\n");

	let formatName = "";
	let activeElementName: string | null = null;
	const vertexPropertyNames = new Set<string>();

	for (const rawHeaderLine of headerLines) {
		const trimmedHeaderLine = rawHeaderLine.trim();
		if (trimmedHeaderLine === "end_header") {
			break;
		}

		if (trimmedHeaderLine.startsWith("format ")) {
			const lineTokens = parseHeaderLineTokens(trimmedHeaderLine);
			formatName = lineTokens[1] ?? "";
			continue;
		}

		if (trimmedHeaderLine.startsWith("element ")) {
			const lineTokens = parseHeaderLineTokens(trimmedHeaderLine);
			activeElementName = lineTokens[1] ?? null;
			continue;
		}

		if (
			trimmedHeaderLine.startsWith("property ") &&
			activeElementName === "vertex"
		) {
			const lineTokens = parseHeaderLineTokens(trimmedHeaderLine);
			const propertyName = lineTokens[lineTokens.length - 1];
			if (propertyName) {
				vertexPropertyNames.add(propertyName);
			}
		}
	}

	return {
		format: formatName,
		vertexPropertyNames,
	};
}

function buildMissingPropertyList(
	vertexPropertyNames: Set<string>,
	requiredPropertyNames: string[],
): string[] {
	return requiredPropertyNames.filter(
		(requiredPropertyName) => !vertexPropertyNames.has(requiredPropertyName),
	);
}

export function validateLikelyGaussianSplatPly(plyBytes: Uint8Array): void {
	const headerPreviewText = new TextDecoder("utf-8").decode(
		plyBytes.slice(0, Math.min(16, plyBytes.byteLength)),
	);
	if (!headerPreviewText.startsWith("ply")) {
		throw new Error(
			"Input file is not a valid PLY file. Header must start with 'ply'.",
		);
	}

	const parsedHeader = parsePlyHeader(plyBytes);
	if (parsedHeader.format !== "binary_little_endian") {
		throw new Error(
			"PLY format is not supported for splat rendering. Expected 'binary_little_endian'.",
		);
	}

	const requiredSplatPropertyNames = [
		"x",
		"y",
		"z",
		"opacity",
		"scale_0",
		"scale_1",
		"scale_2",
		"rot_0",
		"rot_1",
		"rot_2",
		"rot_3",
	];
	const missingPropertyNames = buildMissingPropertyList(
		parsedHeader.vertexPropertyNames,
		requiredSplatPropertyNames,
	);
	if (missingPropertyNames.length > 0) {
		throw new Error(
			`PLY file is not a Gaussian splat format supported by this viewer. Missing vertex properties: ${missingPropertyNames.join(", ")}.`,
		);
	}
}
