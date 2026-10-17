const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib");
const { pdfChunksForBytes, splitChunkBytes } = require("..");

async function pdfWithPages(count) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) pdf.addPage([100, 100]);
  return pdf.save();
}

test("PDF chunks retain configured overlap separately from predecessor overlap", async () => {
  const bytes = await pdfWithPages(21);
  const result = await pdfChunksForBytes(bytes, {
    sourceFile: "source.pdf",
    pagesPerChunk: 20,
    overlapPages: 2
  });
  assert.equal(result.totalPages, 21);
  assert.deepEqual(result.chunks.map((chunk) => ({
    startPage: chunk.startPage,
    endPage: chunk.endPage,
    overlapPages: chunk.overlapPages,
    configuredOverlapPages: chunk.configuredOverlapPages
  })), [
    { startPage: 1, endPage: 20, overlapPages: 0, configuredOverlapPages: 2 },
    { startPage: 19, endPage: 21, overlapPages: 2, configuredOverlapPages: 2 }
  ]);
  assert.equal((await PDFDocument.load(Buffer.from(result.chunks[0].dataBase64, "base64"))).getPageCount(), 20);
});

test("recursive splitting produces exactly the configured total overlap", async () => {
  const bytes = await pdfWithPages(40);
  const [left, right] = await splitChunkBytes(bytes, {
    startPage: 19,
    endPage: 38,
    overlapPages: 2,
    configuredOverlapPages: 2,
    sourceFile: "source.pdf"
  });
  assert.deepEqual(
    [left, right].map((chunk) => ({
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      overlapPages: chunk.overlapPages,
      configuredOverlapPages: chunk.configuredOverlapPages
    })),
    [
      { startPage: 19, endPage: 29, overlapPages: 2, configuredOverlapPages: 2 },
      { startPage: 28, endPage: 38, overlapPages: 2, configuredOverlapPages: 2 }
    ]
  );
  assert.equal(left.endPage - right.startPage + 1, 2);
});

test("recursive splitting does not double a three-page overlap", async () => {
  const bytes = await pdfWithPages(30);
  const [left, right] = await splitChunkBytes(bytes, {
    startPage: 1,
    endPage: 30,
    overlapPages: 0,
    configuredOverlapPages: 3,
    sourceFile: "dense.pdf"
  });
  assert.deepEqual(
    [left, right].map((chunk) => [chunk.startPage, chunk.endPage]),
    [[1, 17], [15, 30]]
  );
  assert.equal(left.endPage - right.startPage + 1, 3);
});

test("recursive splitting caps overlap so both child chunks shrink", async () => {
  const bytes = await pdfWithPages(2);
  const chunks = await splitChunkBytes(bytes, {
    startPage: 1,
    endPage: 2,
    overlapPages: 0,
    configuredOverlapPages: 3,
    sourceFile: "source.pdf"
  });
  assert.deepEqual(chunks.map((chunk) => [chunk.startPage, chunk.endPage]), [[1, 1], [2, 2]]);
  await assert.rejects(() => splitChunkBytes(bytes, {
    startPage: 1,
    endPage: 2,
    configuredOverlapPages: -1
  }), /overlapPages/);
});
