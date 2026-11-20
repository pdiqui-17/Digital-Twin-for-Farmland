import { readFileSync } from "node:fs";
import { DEFAULT_THRESHOLDS } from "@farm/shared";
import { calibrate } from "./domain/calibrate";
import { parseCsv, resample, splitByTime } from "./domain/dataset";
import { evaluate, formatTable } from "./domain/evaluate";
import { generateSynthetic } from "./domain/synthetic";

// Dùng: npm run eval            -> dữ liệu tổng hợp
//       npm run eval -- data.csv -> CSV: ts,moisture,temp,rain,open (một zone, từ sensor_readings + commands)
const csv = process.argv[2];
const th = DEFAULT_THRESHOLDS;
const source = csv ? "CSV " + csv : "SYNTHETIC (21 ngày, seed 42) - không phải dữ liệu thật";
const rows = csv ? resample(parseCsv(readFileSync(csv, "utf8")), 60) : generateSynthetic(21 * 24);
const { train, test } = splitByTime(rows, 0.7);

const fit = calibrate(train, th.fieldCapacity);
console.log(`Nguồn: ${source}`);
console.log(`Train ${train.length} mẫu, test ${test.length} mẫu (chia theo thời gian)`);
console.log("Hệ số đã fit:", fit.params, `| RMSE Δ một bước (train): ${fit.rmseDelta.toFixed(3)}`);
if (fit.unidentified.length) console.log("Không xác định được:", fit.unidentified.join(", "));
console.log("\nMAE / RMSE (đơn vị %VWC), đầu vào tương lai là giá trị thực tế:\n");
console.log(formatTable(evaluate(test, fit.params, 1, th.fieldCapacity, [1, 3, 6, 12])));
