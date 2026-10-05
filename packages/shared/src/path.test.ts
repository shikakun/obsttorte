import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidPathError, isPortablePath, normalizePath, toPathKey, validatePath } from "./path";

const utf8 = new TextEncoder();

describe("validatePath", () => {
  it("accepts a normalized relative path", () => {
    expect(() => validatePath("Notes/Hello.md")).not.toThrow();
  });

  it("rejects empty, traversing, absolute, non-NFC, overlong, and control-character paths", () => {
    const invalid = [
      "",
      "/",
      "/etc/passwd",
      "../secret",
      "a/../b",
      "a//b",
      "a/./b",
      ".",
      "..",
      "C:/note",
      "C:note",
      "bad\u0000name",
      "main\u202esj.js",
      "e\u0301.md",
      "a".repeat(256),
    ];
    for (const path of invalid) {
      expect(() => validatePath(path)).toThrow(InvalidPathError);
    }
  });

  it("does not accept a random string that violates the rules", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (value) => {
        try {
          validatePath(value);
        } catch (error) {
          return error instanceof InvalidPathError;
        }
        return (
          value.length > 0 &&
          value === value.normalize("NFC") &&
          !value.startsWith("/") &&
          !/^[a-zA-Z]:/.test(value) &&
          utf8.encode(value).byteLength <= 1024 &&
          value.split("/").every((segment) => {
            return (
              segment !== "" &&
              segment !== "." &&
              segment !== ".." &&
              utf8.encode(segment).byteLength <= 255
            );
          })
        );
      }),
    );
  });
});

describe("normalizePath", () => {
  it("converts backslashes and composes characters", () => {
    expect(normalizePath("Notes\\e\u0301.md")).toBe("Notes/é.md");
  });
});

describe("toPathKey", () => {
  it("folds ß into ss", () => {
    expect(toPathKey("straße")).toBe(toPathKey("STRASSE"));
  });

  it("returns the same key when only case or normalization differs", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (value) => {
        const key = toPathKey(value);
        return (
          key === toPathKey(value.normalize("NFD")) &&
          key === toPathKey(value.normalize("NFC")) &&
          key === toPathKey(value.toUpperCase()) &&
          key === toPathKey(value.toLowerCase())
        );
      }),
    );
  });
});

describe("isPortablePath", () => {
  it("accepts names that every supported file system can store", () => {
    const portable = [
      "Notes/Hello.md",
      ".obsidian/app.json",
      "日記/2026-10-05.md",
      "Console.md",
      "a.b.c",
    ];
    for (const path of portable) expect(isPortablePath(path)).toBe(true);
  });

  it("rejects names that Windows cannot create", () => {
    const unportable = [
      "Notes/a:b.md",
      "what?.md",
      'say "hi".md',
      "a<b>.md",
      "pipe|.md",
      "star*.md",
      "trailing.",
      "Notes/trailing /a.md",
      "CON",
      "nul.md",
      "Folder/com1.txt",
      "LPT9 .md",
      "COM¹.md",
    ];
    for (const path of unportable) expect(isPortablePath(path)).toBe(false);
  });
});
