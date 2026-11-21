import { readFileSync } from "node:fs";
import { deriveThresholds } from "@digital-twin/shared";
import { calibrate } from "./domain/calibrate";
import { parseCsv, resample, splitByTime } from "./domain/dataset";
import { evaluate, formatTable } from "./domain/evaluate";
import { generateSynthetic, SYNTHETIC_THRESHOLDS } from "./domain/synthetic";

// Dùng: npm run eval                         -> dữ liệu tổng hợp
//       npm run eval -- data.csv 45,70       -> CSV: ts,moisture,temp,rain,open (một zone, từ sensor_readings + commands)
//                                               kèm khoảng ẩm tối ưu của zone (zones.moisture_optimal_min,max)
const csv = process.argv[2];
const range = (process.argv[3] ?? "45,70").split(",").map(Number) as [number, number];
const th = csv ? deriveThresholds(range[0], range[1]) : SYNTHETIC_THRESHOLDS;
const source = csv ? `CSV ${csv} (tối ưu ${range[0]}-${range[1]}%)` : "SYNTHETIC (21 ngày, seed 42) - không phải dữ liệu thật";
const rows = csv ? resample(parseCsv(readFileSync(csv, "utf8")), 60) : generateSynthetic(21 * 24);
const { train, test } = splitByTime(rows, 0.7);

const fit = calibrate(train, th.fieldCapacity);
console.log(`Nguồn: ${source}`);
console.log(`Train ${train.length} mẫu, test ${test.length} mẫu (chia theo thời gian)`);
console.log("Hệ số đã fit:", fit.params, `| RMSE Δ một bước (train): ${fit.rmseDelta.toFixed(3)}`);
if (fit.unidentified.length) console.log("Không xác định được:", fit.unidentified.join(", "));
console.log("\nMAE / RMSE (đơn vị %VWC), đầu vào tương lai là giá trị thực tế:\n");
console.log(formatTable(evaluate(test, fit.params, 1, th.fieldCapacity, [1, 3, 6, 12])));
