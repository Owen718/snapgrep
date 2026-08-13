import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  KernelBindingError,
  bigintToSafeNumber,
  loadKernelBinding,
  nativeKernelErrorCode,
} from "../src/kernel-binding.ts";

describe("kernel binding boundary", () => {
  it("does not discover or load a native addon implicitly", () => {
    expect(() => loadKernelBinding("relative.node")).toThrowError(
      expect.objectContaining<Partial<KernelBindingError>>({ code: "PFG_BINDING_PATH" }),
    );
    const missing = path.resolve("/definitely-missing/pi-fast-grep.node");
    expect(() => loadKernelBinding(missing)).toThrowError(
      expect.objectContaining<Partial<KernelBindingError>>({ code: "PFG_BINDING_LOAD" }),
    );
  });

  it("converts bigint only inside the JavaScript safe-integer range", () => {
    expect(bigintToSafeNumber(0n, "offset")).toBe(0);
    expect(bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER), "offset")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1, "1"]) {
      expect(() => bigintToSafeNumber(value, "offset")).toThrowError(
        expect.objectContaining<Partial<KernelBindingError>>({ code: "PFG_RANGE_UNSAFE" }),
      );
    }
  });

  it("extracts stable native error prefixes without trusting generic N-API status", () => {
    expect(nativeKernelErrorCode(new Error("[PFG_CORRUPT_INDEX] corrupt"))).toBe(
      "PFG_CORRUPT_INDEX",
    );
    expect(nativeKernelErrorCode(new Error("plain error"))).toBeUndefined();
    expect(nativeKernelErrorCode("not an error")).toBeUndefined();
  });
});
