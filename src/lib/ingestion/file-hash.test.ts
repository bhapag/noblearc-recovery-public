import { describe, expect, it } from "vitest";
import { hashFileContent } from "./file-hash";

describe("hashFileContent", () => {
  it("is deterministic for identical bytes", () => {
    const bytes = Buffer.from("hello world");
    expect(hashFileContent(bytes)).toBe(hashFileContent(Buffer.from("hello world")));
  });

  it("differs for different bytes", () => {
    expect(hashFileContent(Buffer.from("a"))).not.toBe(hashFileContent(Buffer.from("b")));
  });

  it("produces a 64-char hex sha256 digest", () => {
    const hash = hashFileContent(Buffer.from("x"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
