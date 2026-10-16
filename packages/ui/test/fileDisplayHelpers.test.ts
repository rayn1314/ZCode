import { describe, expect, it, vi } from "vitest";
import {
  getKnownMaterialIconNames,
  resolveAvailableMaterialIconName,
  resolveIconName,
} from "../src/lib/fileDisplayHelpers.js";

type IndexedGlobal = typeof globalThis & { __MATERIAL_ICONS_INDEX__?: readonly string[] };

describe("resolveAvailableMaterialIconName", () => {
  it("keeps names unchanged when no index is injected (conservative fallback)", () => {
    expect(resolveAvailableMaterialIconName("text", null)).toBe("text");
    expect(resolveAvailableMaterialIconName("npm", null)).toBe("npm");
  });

  it("keeps names that exist in the known icon index", () => {
    const known = new Set(["document", "folder", "npm"]);
    expect(resolveAvailableMaterialIconName("npm", known)).toBe("npm");
  });

  it("keeps the document fallback even when absent from the index", () => {
    const known = new Set(["folder"]);
    expect(resolveAvailableMaterialIconName("document", known)).toBe("document");
  });

  it("falls back to document for icons missing from the index", () => {
    const known = new Set(["document", "folder", "npm"]);
    expect(resolveAvailableMaterialIconName("text", known)).toBe("document");
  });
});

describe("getKnownMaterialIconNames", () => {
  it("returns null before the build-time index is injected", () => {
    expect(getKnownMaterialIconNames()).toBeNull();
  });

  it("builds a set from the injected global index", async () => {
    vi.resetModules();
    (globalThis as IndexedGlobal).__MATERIAL_ICONS_INDEX__ = ["document", "folder", "npm"];
    try {
      const fresh = await import("../src/lib/fileDisplayHelpers.js");
      expect(fresh.getKnownMaterialIconNames()).toEqual(new Set(["document", "folder", "npm"]));
      expect(fresh.resolveAvailableMaterialIconName("npm", fresh.getKnownMaterialIconNames())).toBe(
        "npm",
      );
      expect(
        fresh.resolveAvailableMaterialIconName("text", fresh.getKnownMaterialIconNames()),
      ).toBe("document");
    } finally {
      delete (globalThis as IndexedGlobal).__MATERIAL_ICONS_INDEX__;
    }
  });
});

describe("resolveIconName", () => {
  it("keeps resolving mapped extensions to their alias icons", () => {
    expect(resolveIconName("main.ts")).toBe("typescript");
    expect(resolveIconName("package.json")).toBe("json");
  });

  it("resolves unknown extensions to the extension itself (filtered later at src build time)", () => {
    expect(resolveIconName("notes.text")).toBe("text");
    expect(resolveIconName("notes.md")).toBe("markdown");
  });
});
