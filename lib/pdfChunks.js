const { PDFDocument } = require("pdf-lib");
const path = require("path");

const DEFAULT_PAGES_PER_CHUNK = 30;
const DEFAULT_OVERLAP_PAGES = 3;

function pageRanges(totalPages, { pagesPerChunk, overlapPages } = {}) {
  if (!Number.isInteger(totalPages) || totalPages < 1) return [];
  const resolvedPagesPerChunk = pagesPerChunk ?? DEFAULT_PAGES_PER_CHUNK;
  const resolvedOverlapPages = overlapPages ?? DEFAULT_OVERLAP_PAGES;
  if (!Number.isInteger(resolvedPagesPerChunk) || resolvedPagesPerChunk < 1) throw new Error("pagesPerChunk must be a positive integer.");
  if (!Number.isInteger(resolvedOverlapPages) || resolvedOverlapPages < 0 || resolvedOverlapPages >= resolvedPagesPerChunk) {
    throw new Error("overlapPages must be a non-negative integer smaller than pagesPerChunk.");
  }
  const ranges = [];
  for (let startPage = 1; startPage <= totalPages;) {
    const endPage = Math.min(totalPages, startPage + resolvedPagesPerChunk - 1);
    ranges.push({ startPage, endPage, overlapPages: ranges.length ? resolvedOverlapPages : 0 });
    if (endPage === totalPages) break;
    startPage = endPage - resolvedOverlapPages + 1;
  }
  return ranges;
}

async function chunkFromRange(sourcePdf, range, sourceFile, configuredOverlapPages) {
  const output = await PDFDocument.create();
  const pages = await output.copyPages(sourcePdf, Array.from({ length: range.endPage - range.startPage + 1 }, (_, index) => range.startPage - 1 + index));
  pages.forEach((page) => output.addPage(page));
  const bytes = await output.save();
  return {
    id: `${path.basename(sourceFile, path.extname(sourceFile))}-${range.startPage}-${range.endPage}`,
    filename: sourceFile,
    sourceFile,
    startPage: range.startPage,
    endPage: range.endPage,
    overlapPages: range.overlapPages || 0,
    configuredOverlapPages,
    pagesTotal: sourcePdf.getPageCount(),
    type: "document",
    mediaType: "application/pdf",
    dataBase64: Buffer.from(bytes).toString("base64")
  };
}

async function pdfChunksForBytes(sourceBytes, options = {}) {
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const sourceFile = options.sourceFile || "document.pdf";
  const configuredOverlapPages = options.overlapPages ?? DEFAULT_OVERLAP_PAGES;
  const ranges = pageRanges(sourcePdf.getPageCount(), options);
  const chunks = [];
  for (const range of ranges) {
    chunks.push(await chunkFromRange(sourcePdf, range, sourceFile, configuredOverlapPages));
  }
  return { totalPages: sourcePdf.getPageCount(), chunks };
}

async function splitChunkBytes(sourceBytes, chunk, { overlapPages } = {}) {
  if (!chunk?.startPage || !chunk?.endPage || chunk.endPage <= chunk.startPage) return [chunk];
  const requestedOverlap = overlapPages ?? chunk.configuredOverlapPages ?? DEFAULT_OVERLAP_PAGES;
  if (!Number.isInteger(requestedOverlap) || requestedOverlap < 0) throw new Error("overlapPages must be a non-negative integer.");
  const pageCount = chunk.endPage - chunk.startPage + 1;
  const overlap = Math.min(requestedOverlap, Math.max(0, pageCount - 2));
  const leftLength = Math.ceil((pageCount + overlap) / 2);
  const leftEndPage = chunk.startPage + leftLength - 1;
  const rightStartPage = leftEndPage - overlap + 1;
  const ranges = [
    { startPage: chunk.startPage, endPage: leftEndPage, overlapPages: chunk.overlapPages || 0 },
    { startPage: rightStartPage, endPage: chunk.endPage, overlapPages: overlap }
  ];
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const sourceFile = chunk.sourceFile || chunk.filename || "document.pdf";
  const chunks = [];
  for (const range of ranges) {
    chunks.push(await chunkFromRange(sourcePdf, range, sourceFile, requestedOverlap));
  }
  return chunks;
}

module.exports = { DEFAULT_PAGES_PER_CHUNK, DEFAULT_OVERLAP_PAGES, pageRanges, pdfChunksForBytes, splitChunkBytes };
