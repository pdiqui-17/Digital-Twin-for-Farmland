import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModel, saveModel } from "../src/modelFile";
import { DEFAULT_PARAMS } from "../src/domain/waterBalance";
import type { ModelState } from "../src/app";

describe("modelFile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-model-"));
  const file = path.join(dir, "sub", "model.json");

  it("chưa có file -> undefined (dùng hệ số mặc định)", () => {
    expect(loadModel(file)).toBeUndefined();
  });
  it("ghi rồi đọc lại đúng hệ số theo zone", () => {
    const fit = { params: { ...DEFAULT_PARAMS, irrigGain: 5 }, rmseDelta: 0.3, nRows: 60, unidentified: [] };
    const m: ModelState = { params: DEFAULT_PARAMS, fit: null, zones: { "zone-A": { params: fit.params, fit } } };
    saveModel(file, m);
    expect(loadModel(file)).toEqual(m);
  });
  it("file hỏng -> undefined, không làm sập service", () => {
    fs.writeFileSync(file, "{hỏng");
    expect(loadModel(file)).toBeUndefined();
  });
});
