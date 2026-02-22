import type { SplatViewerMetadata } from "../types/splat.js";

interface PlyPropertyDescriptor {
	name: string;
	byteSize: number;
}

interface PlyElementDescriptor {
	name: string;
	count: number;
	properties: PlyPropertyDescriptor[];
	bytesPerElement: number;
}

function getPropertyByteSize(propertyTypeName: string): number {
	switch (propertyTypeName) {
		case "char":
		case "uchar":
		case "int8":
		case "uint8":
			return 1;
		case "short":
		case "ushort":
		case "int16":
		case "uint16":
			return 2;
		case "int":
		case "uint":
		case "int32":
		case "uint32":
		case "float":
		case "float32":
			return 4;
		case "double":
		case "float64":
			return 8;
		default:
			return 4;
	}
}

function parsePlyHeader(plyBytes: Uint8Array): {
	headerEndByteOffset: number;
	elements: PlyElementDescriptor[];
	isBinaryLittleEndian: boolean;
} {
	const headerSliceLength = Math.min(10_000, plyBytes.byteLength);
	const decodedHeaderText = new TextDecoder("utf-8").decode(
		plyBytes.slice(0, headerSliceLength),
	);
	const headerLines = decodedHeaderText.split("\n");

	const parsedElements: PlyElementDescriptor[] = [];
	let currentElementDescriptor: PlyElementDescriptor | null = null;
	let currentByteOffset = 0;
	let headerEndByteOffset = 0;
	let isBinaryLittleEndian = false;

	for (const rawHeaderLine of headerLines) {
		const headerLine = rawHeaderLine.trim();
		currentByteOffset += rawHeaderLine.length + 1;

		if (headerLine === "end_header") {
			headerEndByteOffset = currentByteOffset;
			break;
		}

		if (headerLine.startsWith("format ")) {
			isBinaryLittleEndian = headerLine.includes("binary_little_endian");
			continue;
		}

		if (headerLine.startsWith("element ")) {
			if (currentElementDescriptor) {
				currentElementDescriptor.bytesPerElement =
					currentElementDescriptor.properties.reduce(
						(totalByteSize, propertyDescriptor) =>
							totalByteSize + propertyDescriptor.byteSize,
						0,
					);
				parsedElements.push(currentElementDescriptor);
			}

			const splitElementLine = headerLine.split(/\s+/);
			const parsedCountValue = Number.parseInt(splitElementLine[2] ?? "0", 10);
			currentElementDescriptor = {
				name: splitElementLine[1] ?? "",
				count: Number.isNaN(parsedCountValue) ? 0 : parsedCountValue,
				properties: [],
				bytesPerElement: 0,
			};
			continue;
		}

		if (headerLine.startsWith("property ") && currentElementDescriptor) {
			const splitPropertyLine = headerLine.split(/\s+/);
			if (splitPropertyLine.length >= 3) {
				const propertyTypeName = splitPropertyLine[1] ?? "float";
				const propertyName =
					splitPropertyLine[splitPropertyLine.length - 1] ?? "";
				currentElementDescriptor.properties.push({
					name: propertyName,
					byteSize: getPropertyByteSize(propertyTypeName),
				});
			}
		}
	}

	if (currentElementDescriptor) {
		currentElementDescriptor.bytesPerElement =
			currentElementDescriptor.properties.reduce(
				(totalByteSize, propertyDescriptor) =>
					totalByteSize + propertyDescriptor.byteSize,
				0,
			);
		parsedElements.push(currentElementDescriptor);
	}

	return {
		headerEndByteOffset,
		elements: parsedElements,
		isBinaryLittleEndian,
	};
}

export function summarizePlyMetadata(
	plyBytes: Uint8Array,
): SplatViewerMetadata {
	try {
		const parsedHeader = parsePlyHeader(plyBytes);
		if (
			!parsedHeader.isBinaryLittleEndian ||
			parsedHeader.headerEndByteOffset <= 0
		) {
			return { hasMetadata: false };
		}

		const elementDescriptorByName = new Map<string, PlyElementDescriptor>();
		let currentDataByteOffset = parsedHeader.headerEndByteOffset;
		const dataOffsetByElementName = new Map<string, number>();
		for (const elementDescriptor of parsedHeader.elements) {
			elementDescriptorByName.set(elementDescriptor.name, elementDescriptor);
			dataOffsetByElementName.set(
				elementDescriptor.name,
				currentDataByteOffset,
			);
			currentDataByteOffset +=
				elementDescriptor.count * elementDescriptor.bytesPerElement;
		}

		const imageSizeElementDescriptor =
			elementDescriptorByName.get("image_size");
		const intrinsicElementDescriptor = elementDescriptorByName.get("intrinsic");
		if (!imageSizeElementDescriptor && !intrinsicElementDescriptor) {
			return { hasMetadata: false };
		}

		const metadataSummary: SplatViewerMetadata = { hasMetadata: true };
		const dataView = new DataView(
			plyBytes.buffer,
			plyBytes.byteOffset,
			plyBytes.byteLength,
		);

		if (imageSizeElementDescriptor) {
			const imageSizeElementByteOffset =
				dataOffsetByElementName.get("image_size");
			if (imageSizeElementByteOffset !== undefined) {
				const parsedImageWidth = dataView.getUint32(
					imageSizeElementByteOffset,
					true,
				);
				const parsedImageHeight = dataView.getUint32(
					imageSizeElementByteOffset + 4,
					true,
				);
				if (parsedImageWidth > 0 && parsedImageHeight > 0) {
					metadataSummary.imageWidth = parsedImageWidth;
					metadataSummary.imageHeight = parsedImageHeight;
				}
			}
		}

		if (intrinsicElementDescriptor) {
			const intrinsicElementByteOffset =
				dataOffsetByElementName.get("intrinsic");
			if (intrinsicElementByteOffset !== undefined) {
				if (intrinsicElementDescriptor.properties.length >= 9) {
					const focalLengthInX = dataView.getFloat32(
						intrinsicElementByteOffset,
						true,
					);
					const focalLengthInY = dataView.getFloat32(
						intrinsicElementByteOffset + 16,
						true,
					);
					const averagedFocalLength = (focalLengthInX + focalLengthInY) / 2;
					if (Number.isFinite(averagedFocalLength) && averagedFocalLength > 0) {
						metadataSummary.focalLength = averagedFocalLength;
					}
				} else if (intrinsicElementDescriptor.properties.length >= 2) {
					const focalLengthInX = dataView.getFloat32(
						intrinsicElementByteOffset,
						true,
					);
					const focalLengthInY = dataView.getFloat32(
						intrinsicElementByteOffset + 4,
						true,
					);
					const averagedFocalLength = (focalLengthInX + focalLengthInY) / 2;
					if (Number.isFinite(averagedFocalLength) && averagedFocalLength > 0) {
						metadataSummary.focalLength = averagedFocalLength;
					}
				}
			}
		}

		return metadataSummary;
	} catch {
		return { hasMetadata: false };
	}
}
