import fs from "node:fs";
import path from "node:path";
import type { ModelState } from "./app";

/** Đọc hệ số đã fit từ file JSON. Không có file hoặc file hỏng -> undefined (dùng hệ số mặc định). */
export function loadModel(file: string): ModelState | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as ModelState;
    if (!m?.params) return undefined;
    return { params: m.params, fit: m.fit ?? null, zones: m.zones ?? {} };
  } catch {
    return undefined;
  }
}

/** Ghi hệ số ra file (ghi file tạm rồi đổi tên, để không để lại file dở dang). */
export function saveModel(file: string, m: ModelState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, file);
}
