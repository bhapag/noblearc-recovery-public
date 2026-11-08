import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sniffFileKind, assertUploadSize, MAX_UPLOAD_BYTES, FileParseError } from "./parse-file";

function fixture(name: string): Buffer {
  return readFileSync(path.join(__dirname, "__fixtures__", name));
}

describe("sniffFileKind", () => {
  it("accepts a real CSV with a .csv extension", () => {
    expect(sniffFileKind("settlement-standard.csv", fixture("settlement-standard.csv"))).toBe("csv");
  });

  it("accepts a real XLSX (ZIP-signed) with a .xlsx extension", () => {
    expect(sniffFileKind("settlement-standard.xlsx", fixture("settlement-standard.xlsx"))).toBe("xlsx");
  });

  it("rejects an unsupported extension", () => {
    expect(() => sniffFileKind("settlement.pdf", Buffer.from("%PDF-1.4"))).toThrow(FileParseError);
  });

  it("rejects a .xlsx extension whose bytes are not a ZIP archive (extension spoofing)", () => {
    expect(() => sniffFileKind("fake.xlsx", Buffer.from("just some text"))).toThrow(FileParseError);
  });

  it("rejects a .csv extension whose bytes are binary (extension spoofing)", () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff, 0xfe]);
    expect(() => sniffFileKind("fake.csv", binary)).toThrow(FileParseError);
  });
});

describe("assertUploadSize", () => {
  it("accepts a normal-sized file", () => {
    expect(() => assertUploadSize(1024)).not.toThrow();
  });

  it("rejects an empty file", () => {
    expect(() => assertUploadSize(0)).toThrow(FileParseError);
  });

  it("rejects a file over the size limit", () => {
    expect(() => assertUploadSize(MAX_UPLOAD_BYTES + 1)).toThrow(FileParseError);
  });
});
