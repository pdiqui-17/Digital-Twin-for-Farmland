# Role B: Twin Core — cách hoạt động, kết quả và kế hoạch

Phạm vi: `services/twin-service`, `services/controller`, `services/analytics`, phần twin trong `packages/shared` (`src/twin.ts`).
Tài liệu này có hai phần: **Phần I** giải thích hệ thống hoạt động thế nào và đã làm được gì (cập nhật 21/11/2026); **Phần II** là kế hoạch gốc, giữ để đối chiếu. Chi tiết API và biến môi trường: `docs/api.md`.

**Tóm tắt.** Role B biến dữ liệu cảm biến của Role A thành quyết định: giữ trạng thái số của từng zone, tự mở/đóng van tưới, cảnh báo khi có sự cố và dự đoán độ ẩm. Mốc MVP "hạn hán → cảnh báo → tự tưới → độ ẩm phục hồi" đã chạy đạt với simulator thật của Role A; 136/136 test toàn repo pass. Code nằm trên nhánh `b/twin-core`.

# Phần I. Cách hoạt động và kết quả

## 1. Bức tranh tổng thể

```
           ROLE A                                          ROLE B
 ┌───────────┐  MQTT   ┌───────────┐  Kafka telemetry.clean  ┌──────────────┐  HTTP /zones  ┌────────────┐
 │ simulator │────────>│ processor │────────────────────────>│ twin-service │<──────────────│ controller │
 │  (3001)   │ telemetry│  (3002)   │                         │    (3010)    │               │   (3011)   │
 └───────────┘         └─────┬─────┘                         └──────┬───────┘               └─────┬──────┘
      ^   │                  │ ghi                                  │ ghi                         │ ghi commands, alerts
      │   │ MQTT valve/state  v                                      v                             │ Kafka alerts, Telegram
      │   └──────────> sensor_readings                          twin_state                         │
      │                (TimescaleDB)          twin nghe valve/state để biết van mở/đóng            │
      └──────────────────────────── MQTT valve/cmd (lệnh mở/đóng) ─────────────────────────────────┘

 analytics (3012): API dự đoán độ ẩm và so sánh lịch tưới, độc lập với vòng trên.
```

Một vòng: simulator đo → processor làm sạch, gắn cờ chất lượng → twin cập nhật trạng thái zone → controller đọc trạng thái mỗi vài giây, quyết định mở/đóng van và cảnh báo → simulator nhận lệnh, đất ẩm lên, vòng tiếp theo phản ánh lại.

| Thành phần | Ai làm | Việc chính | Ghi bảng |
|---|---|---|---|
| simulator, processor, migration 001–004, seed | A | Tạo và làm sạch dữ liệu | `sensor_readings` |
| twin-service | B | Bản sao số của từng zone | `twin_state` |
| controller | B | Tưới tự động, cảnh báo | `commands`, `alerts` |
| analytics | B | Dự đoán, what-if | (không) |
| migration 005 | B (A đã duyệt) | Thêm `rule`, `closed_at` cho `alerts` | |

## 2. Twin Service: bản sao số của từng zone

Twin giữ cho mỗi zone một `ZoneState` (lưu ở cột JSONB `twin_state.state`): giá trị mới nhất của từng cảm biến, các chỉ số tổng hợp, trạng thái van, ngưỡng của zone và `status`.

Khi nhận một bản tin cảm biến từ Kafka `telemetry.clean`:

1. **Bỏ bản tin cũ hoặc trùng** (không mới hơn bản tin trước của cùng cảm biến), nên Kafka gửi lại hay gửi lệch thứ tự cũng không làm sai trạng thái.
2. **Xét cờ chất lượng của processor.** Chỉ `ok` và `noisy_smoothed` được dùng để tính chỉ số. Bản tin `out_of_range`, `stuck`, `missing_signal` vẫn được lưu, nhưng cảm biến đó vào danh sách `faultySensors`.
3. **Tính chỉ số dẫn xuất:**
    - *Stress nước* 0–1: 0 khi độ ẩm còn từ cận dưới khoảng tối ưu trở lên, tăng tuyến tính tới 1 ở điểm héo.
    - *Nguy cơ nấm* 0–1: cộng dồn số phút độ ẩm không khí ≥ 85% và nhiệt độ 15–28 °C; đủ 6 giờ liên tục thì bằng 1, điều kiện hết thì giảm gấp đôi tốc độ.
4. **Xếp trạng thái:** `unknown` nếu quá `TWIN_STALE_AFTER_SEC` không có độ ẩm đất dùng được; `critical` / `dry` nếu dưới ngưỡng; còn lại `ok`.

**Ngưỡng theo từng zone** lấy từ khoảng ẩm tối ưu trong bảng `zones` của A: khô khi dưới cận dưới, nguy cấp khi thấp hơn 10 điểm, điểm héo thấp hơn 20 điểm. Ví dụ zone-B (xà lách, tối ưu 55–80%): khô < 55%, nguy cấp < 45%.

Twin cũng nghe MQTT `.../valve/state` để biết van đang mở hay đóng và lệnh nào vừa được thực hiện. Đầu ra: REST (`/zones`, lịch sử), SSE `/stream` đẩy cập nhật thời gian thực, metrics Prometheus.

## 3. Controller: vòng tưới tự động

Mỗi `CTRL_TICK_SEC` giây controller đọc trạng thái mọi zone từ twin, đánh giá cảnh báo, rồi chạy máy trạng thái van của từng zone:

| Pha | Chuyển sang pha sau khi |
|---|---|
| `idle` (chờ) | độ ẩm < ngưỡng khô → gửi lệnh `open` (kèm thời lượng tối đa) |
| `pending` (chờ van xác nhận) | van báo đã mở đúng lệnh → `watering`; quá `CTRL_ACK_TIMEOUT_SEC` → gửi `close` an toàn, cảnh báo, sang `cooldown` |
| `watering` (đang tưới) | độ ẩm đạt điểm giữa khoảng tối ưu, hoặc quá thời lượng tối đa, hoặc mất dữ liệu → gửi `close`, sang `cooldown` |
| `cooldown` (nghỉ) | đủ `CTRL_MIN_REST_SEC` → `idle` |

Ví dụ zone-B: mở khi < 55%, đóng khi đạt 67,5% (giữa 55 và 80).

Cơ chế an toàn:
- Không có dữ liệu thì không mở; đang tưới mà mất dữ liệu thì đóng.
- Van không xác nhận lệnh mở → gửi thêm lệnh đóng. Van không xác nhận lệnh đóng → lệnh `failed` và cảnh báo "có thể vẫn đang tưới".
- Luôn nghỉ giữa hai lần tưới, không tưới liên tục.
- Mỗi lệnh được ghi vào bảng `commands` *trước* khi gửi, có lý do (ví dụ "độ ẩm 53.8% < 55%"), và được theo dõi tới cuối: lệnh mở `sent → acknowledged → completed`, lệnh đóng `sent → completed`.
- Khởi động lại: nạp lệnh gần nhất và cảnh báo đang mở từ DB, nên không tưới lại ngay và không báo trùng.

## 4. Cảnh báo

| Luật | Mở khi | Đóng khi |
|---|---|---|
| `soil_dry` | độ ẩm < ngưỡng khô | độ ẩm ≥ ngưỡng khô + 4 |
| `soil_critical` | độ ẩm < ngưỡng nguy cấp | độ ẩm ≥ ngưỡng nguy cấp + 4 |
| `zone_unknown` | mất dữ liệu độ ẩm ≥ 60 s | có dữ liệu lại |
| `sensor_fault` | có cảm biến bị gắn cờ lỗi ≥ 15 s | hết cảm biến lỗi |
| `fungal_risk` | nguy cơ nấm ≥ 0.7 | < 0.4 |
| `valve_ack_timeout` | van không xác nhận lệnh mở/đóng | van xác nhận sau đó |

Chống spam:
- **Hysteresis**: ngưỡng đóng khác ngưỡng mở, nên giá trị dao động quanh ngưỡng chỉ sinh một cảnh báo.
- **Thời gian xác nhận** (15 s / 60 s): lọc lỗi ngẫu nhiên chỉ một tick và khoảng trống dữ liệu lúc khởi động.
- **Cooldown**: vừa đóng thì chưa mở lại ngay.

Mỗi sự cố là **một dòng** trong bảng `alerts` (một `alertId` từ lúc mở đến lúc đóng, `closed_at` rỗng = đang mở). Chỉ controller ghi bảng này. Sự kiện mở/đóng cũng được đẩy lên Kafka `alerts` và Telegram (nếu cấu hình).

## 5. Analytics: dự đoán và so sánh lịch tưới

Mô hình cân bằng nước đơn giản, cố ý **không** chép công thức của simulator (để sai số không đẹp giả tạo):

```
độ ẩm(t+1) = độ ẩm(t) + Δt × ( −(bay hơi nền + bay hơi theo nhiệt độ × T) + hiệu quả tưới × van mở + hiệu quả mưa × mưa )
```

- `POST /model/calibrate`: fit 4 hệ số từ lịch sử bằng bình phương tối thiểu, ràng buộc không âm.
- `POST /forecast`: quỹ đạo độ ẩm theo giờ, dùng dự báo thời tiết Open-Meteo.
- `POST /whatif`: so sánh nhiều lịch tưới; với mỗi lịch trả độ ẩm thấp nhất, số giờ dưới khoảng tối ưu, số giờ dưới điểm héo, tổng nước, và chọn lịch tốt nhất.
- `npm run eval`: MAE/RMSE của mô hình so với hai baseline (giữ nguyên giá trị, ngoại suy tuyến tính), chia train/test theo thời gian.

- `npm run export-samples`: lấy dữ liệu thật từ DB (`sensor_readings` + `commands`), quy giờ thật sang giờ ruộng, gom thành bước 1 giờ ruộng, ra CSV cho `eval` và `/model/calibrate`.

**Kết quả fit trên dữ liệu thật** (21/11/2026: simulator bật hạn hán, nhanh 600 lần, 9 phút thật ≈ 92 giờ ruộng mỗi zone, 67 lần tưới; fit 63 giờ đầu, đánh giá 28 giờ sau). MAE độ ẩm (%VWC), mô hình so với baseline "giữ nguyên giá trị":

| Zone | Hiệu quả tưới (%/giờ) | Bay hơi (%/giờ/°C) | 1 giờ tới | 3 giờ tới | 6 giờ tới |
|---|---|---|---|---|---|
| A | 4,4 | 0,019 | **0,59** / 0,77 | **1,22** / 1,42 | 2,06 / 2,05 |
| B | 5,9 | 0,036 | **1,04** / 1,21 | 2,42 / 1,96 | 4,59 / 3,31 |
| C | 6,0 | 0,023 | **0,62** / 0,72 | **1,34** / 1,43 | 2,46 / 1,96 |
| D | 4,1 | 0,019 | **0,40** / 0,59 | **1,04** / 1,32 | 1,97 / 1,55 |

Đọc kết quả:
- Ở tầm **1–3 giờ**, mô hình tốt hơn baseline ở 7/8 trường hợp (giảm sai số 10–30%); đây là tầm controller cần để quyết định tưới.
- Ở tầm **6 giờ trở lên**, baseline "giữ nguyên" thắng. Lý do: controller giữ độ ẩm dao động quanh ngưỡng khô, nên "không đổi" tình cờ là dự đoán tốt; còn mô hình chỉ có nhiệt độ, thiếu nắng và độ ẩm không khí (simulator dùng cả hai cho bay hơi), nên sai số cộng dồn theo thời gian.
- Bay hơi nền `evapBase` bị ép về 0 (ước lượng âm), toàn bộ bay hơi được giải thích qua nhiệt độ. Hệ số mưa không fit (dữ liệu hạn hán).
- Mỗi zone chỉ có 28 giờ test (10–21 điểm mỗi tầm); cần chạy lâu hơn để số liệu chắc chắn hơn.

Hiện trạng: controller **chưa** dùng dự đoán.

## 6. Kết quả kiểm thử

**Unit test**: 136/136 pass toàn repo; trong đó của B: twin 32, controller 48, analytics 37. Test controller có một "simulator mini" chạy cả vòng kín (khô → tưới → phục hồi), mất dữ liệu giữa lúc tưới, van không phản hồi, khởi động lại giữa lúc tưới.

**Chạy thật với simulator của A** (21/11/2026, bật hạn hán, simulator tick 1 s ≈ nhanh 300 lần, khoảng 10 phút):

| Zone | Mở van khi | Van xác nhận | Đóng van khi (mục tiêu) |
|---|---|---|---|
| B | 53,8% < 55 | sau 2 s | 69,8% (67,5) |
| A | 44,9% < 45 | sau 2 s | 59,2% (57,5) |
| C | 39,9% < 40 | sau 3 s | 52,6% (52,5) |

- Tổng 16 chu kỳ tưới trên cả 4 zone; mỗi chu kỳ đúng một cảnh báo `soil_dry` mở rồi đóng, không lệnh trùng.
- Tiêm lỗi `stuck` vào cảm biến độ ẩm không khí zone-A: twin đánh dấu cảm biến lỗi, controller mở `sensor_fault`, gỡ lỗi thì cảnh báo đóng.
- Khởi động lại controller giữa chừng: không báo trùng, các lệnh còn dở được theo dõi tiếp.

**Lỗi do chạy thật phát hiện ra, đã sửa kèm test:**
1. Lỗi cảm biến ngẫu nhiên một tick (5 s) sinh cảnh báo bật/tắt liên tục → thêm thời gian xác nhận.
2. Khởi động hệ thống bật `zone_unknown` cho cả 4 zone → như trên.
3. Lệnh đóng van treo mãi ở `sent` → theo dõi xác nhận của lệnh đóng.
4. Tin nhắn đóng cảnh báo ghi "Đã ổn định: … đang khô" → mỗi luật có câu đóng riêng.

## 7. Quyết định thiết kế đã chốt

| Quyết định | Lý do |
|---|---|
| Chỉ controller ghi bảng `alerts` (nhóm đã duyệt) | Một bảng một writer; cảnh báo có vòng đời mở/đóng cần một nơi quản lý duy nhất để không mở trùng và khôi phục đúng khi khởi động lại. Twin chỉ báo cảm biến lỗi trong `faultySensors` |
| Giữ bảng `alerts` của A, chỉ thêm `rule`, `closed_at` (migration 005, A đã duyệt) | Không phá dữ liệu và truy vấn của A; `category` không đủ để phân biệt luật (`zone_unknown` và `sensor_fault` cùng category) |
| Ngưỡng theo từng zone từ bảng `zones` | Mỗi loại cây cần độ ẩm khác nhau; ngưỡng nằm luôn trong `ZoneState` nên controller không cần đọc DB |
| Logic nghiệp vụ là hàm thuần, I/O tách sau interface | Test được không cần Kafka/MQTT/Postgres; B không bị chặn khi hạ tầng chưa có |
| Lỗi ghi DB thì ném ra để Kafka gửi lại | Không mất dữ liệu khi DB trục trặc |
| Không thêm cảm biến mưa | Không có trong yêu cầu; fit mô hình trong lúc bật hạn hán (mưa = 0 là đúng thật) |

## 8. Giới hạn và việc còn lại

Giới hạn đã biết:
- **Lỗi drift** (giá trị lệch dần) chỉ phát hiện được khi vượt giới hạn vật lý; processor không có cờ riêng.
- **Mưa**: không có số đo, nên controller không chặn tưới khi mưa.

Việc tiếp theo, theo thứ tự:
1. Controller dùng dự đoán của analytics (yêu cầu tuần 6), ở tầm 1–3 giờ nơi mô hình đáng tin.
2. Mở PR `b/twin-core` vào `main`.
3. Báo cáo mục 5.4 và kịch bản demo.
4. (Tùy chọn) Chạy thu dữ liệu lâu hơn nếu báo cáo cần số liệu fit chắc hơn.

Đã xong ngày 21/11/2026: tỉ lệ thời gian mô phỏng (mục 9); fit mô hình từ dữ liệu thật (mục 5).

## 9. Thời gian ruộng và thời gian thật

Simulator chạy nhanh hơn thời gian thật (mặc định 60 lần: 5 phút vật lý mỗi tick 5 giây), nhưng `ts` của mọi bản tin là giờ thật. Nếu không tính tỉ lệ, các mốc nghiệp vụ sẽ sai: ví dụ "nghỉ 1 giờ giữa hai lần tưới" thành 60 giờ ruộng, và nguy cơ nấm không bao giờ đạt mức cao.

Twin và controller tự suy tỉ lệ từ chính cấu hình của simulator trong `.env` (`SIMULATOR_TICK_INTERVAL_MS`, `SIMULATOR_PHYSICS_MINUTES_PER_TICK`), hoặc `SIM_TIME_SCALE` nếu đặt (nông trại thật: 1). A không phải sửa gì.

| Loại mốc | Ví dụ | Cách xử lý |
|---|---|---|
| Thời gian của ruộng/cây | thời lượng tưới tối đa, nghỉ giữa hai lần tưới, cooldown cảnh báo, phút tích lũy nguy cơ nấm | cấu hình bằng giây ruộng, tự quy đổi theo tỉ lệ |
| Độ trễ của thiết bị/mạng | chờ van xác nhận, thời gian xác nhận lỗi cảm biến, dữ liệu cũ | giây thật, không đổi |

Kiểm chứng ngày 21/11/2026 ở tốc độ 300 lần, không chỉnh tay mốc nào: controller tự dùng tưới tối đa 6 s thật (30 phút ruộng) và nghỉ 12 s thật (1 giờ ruộng); van đóng đúng lúc hết thời lượng, nghỉ đủ rồi mới tưới lại.

---

# Phần II. Kế hoạch gốc (giữ để đối chiếu)

Nguyên tắc: làm theo thứ tự phụ thuộc, mỗi bước có tiêu chí hoàn thành (DoD) kiểm tra được bằng test hoặc lệnh chạy.

> **Thay đổi so với kế hoạch gốc sau khi tích hợp với Role A (2026-11-21):**
> - Package tên `@digital-twin/*` (không phải `@farm/*`); schema chung của A, phần của B ở `packages/shared/src/twin.ts`.
> - B1.2: dùng 4 loại cảm biến của A (`soil_moisture`, `air_temperature`, `air_humidity`, `light_intensity`); không thêm cảm biến mưa.
> - B1.4: bỏ `010_twin.sql`; dùng migration 001–004 của A + `005_alert_lifecycle.sql` của B.
> - B2.4: bỏ chế độ `INGEST=poll` (Kafka của A đã có). D5: biến là `TWIN_STALE_AFTER_SEC`.
> - D6: nhóm đã duyệt, chỉ Controller ghi `alerts` và publish topic `alerts`.
> - B3.6: closed loop đã chạy đạt với simulator thật (2026-11-21).

## 0. Quyết định thiết kế (chốt trước khi code)

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Logic nghiệp vụ là hàm thuần trong `domain/`, I/O (Kafka, MQTT, Postgres) nằm ở `adapters`/`repositories` sau interface | Test được không cần hạ tầng; B không bị chặn khi A/C chưa xong |
| D2 | Mỗi service có repository in-memory và Postgres, chọn bằng biến môi trường | Chạy local và test nhanh; deploy thật dùng PG |
| D3 | `twin_state` mỗi zone = 1 dòng JSONB, chỉ Twin Service ghi | Đúng nguyên tắc một bảng một writer (mục 3.3 tài liệu gốc) |
| D4 | Chỉ nhận reading mới hơn `lastTs` của sensor đó; reading trùng/cũ bị bỏ qua | Idempotent khi Kafka giao lại, chịu out-of-order |
| D5 | Zone quá `STALE_AFTER_SEC` không có dữ liệu thì `status = unknown` | Twin không giả vờ biết điều nó không biết |
| D6 | Cảnh báo: Twin Service/Controller chỉ publish topic `alerts`; một module `AlertStore` duy nhất ghi bảng `alerts` (trong Controller) | Sửa mâu thuẫn mục 3.3: một bảng một writer |
| D7 | Cảnh báo có hysteresis (ngưỡng vào ≠ ngưỡng ra) và cooldown, có vòng đời open/closed | Tránh spam Telegram khi giá trị dao động quanh ngưỡng |
| D8 | Van là máy trạng thái `idle → pending → watering → cooldown`; zone `unknown` thì không tự tưới | An toàn khi mất dữ liệu |
| D9 | Mô hình Analytics là cân bằng nước tuyến tính 3 hệ số (bay hơi, hiệu quả tưới, hiệu quả mưa), fit bằng bình phương tối thiểu; KHÔNG dùng công thức của simulator | Tránh sai số đẹp giả tạo |
| D10 | Đánh giá bằng chia train/test theo thời gian, so MAE/RMSE với baseline persistence và linear-trend | Số liệu cho báo cáo mục 5.4 |

## 1. Hợp đồng dữ liệu (tuần 1)

- B1.1 `packages/shared`: zod schema + type cho `Reading`, `ZoneState`, `Alert`, `Command`, `ValveState`; hằng số topic MQTT/Kafka và hàm dựng topic. **DoD:** `npm test -w @farm/shared` pass; schema parse đúng ví dụ mục 3.4.
- B1.2 Danh sách chỉ số cần Processor chuẩn hóa: `soil_moisture` (%), `soil_temp` (°C), `air_temp` (°C), `air_humidity` (%), `rain` (mm/h), `leaf_wetness` (tùy chọn). **DoD:** ghi trong `docs/api.md`, gửi A.
- B1.3 `docs/api.md`: API Twin Service, Controller, Analytics. **DoD:** cả nhóm duyệt.
- B1.4 `db/migrations/010_twin.sql`: DDL `twin_state`, `commands`, `alerts` (đề xuất cho A merge). **DoD:** file SQL chạy được trên Timescale/Postgres.
- B1.5 `scripts/fake-feed.ts`: sinh reading giả theo schema để B không phụ thuộc A. **DoD:** chạy lệnh thấy Twin Service cập nhật.

## 2. Twin Service (tuần 2-3)

- B2.1 `domain/derived.ts`: stress nước (0-1) từ độ ẩm đất với ngưỡng héo WP và sức chứa FC; nguy cơ nấm (0-1) từ độ ẩm không khí và nhiệt độ kéo dài. **DoD:** test bảng giá trị biên.
- B2.2 `domain/twin.ts`: `applyReading(state, reading, now)` thuần: kiểm tra D4, cập nhật sensor, tính lại derived, tính `status`. `markStale(state, now)` theo D5. **DoD:** test trùng, cũ, mất tín hiệu, quality=bad.
- B2.3 `repositories`: interface `TwinRepository` + `InMemoryTwinRepository` + `PgTwinRepository` (upsert JSONB). **DoD:** test in-memory; PG kiểm tra bằng SQL ở B1.4.
- B2.4 `ingest`: consumer Kafka `telemetry.clean` (kafkajs) gọi `applyReading`; chế độ `INGEST=poll` đọc trực tiếp `sensor_readings` khi Kafka chưa sẵn sàng. **DoD:** chạy với fake-feed ở chế độ memory.
- B2.5 REST: `GET /zones`, `GET /zones/:id`, `GET /zones/:id/history?metric&from&to&limit`, `/healthz`, `/readyz`, `/metrics`. **DoD:** test HTTP.
- B2.6 SSE `GET /stream` đẩy cập nhật zone. **DoD:** test nhận event sau khi apply reading.
- B2.7 Metrics Prometheus: `twin_readings_applied_total`, `twin_readings_dropped_total{reason}`, `twin_zone_status{zone,status}`, `twin_ingest_lag_seconds`. **DoD:** `/metrics` có các series.
- B2.8 Dashboard Grafana: JSON provisioning 4 zone (moisture, stress, status). **DoD:** file JSON hợp lệ, import được.

## 3. Cảnh báo và Controller (tuần 4-5)

- B3.1 `domain/alerts.ts`: `evaluateAlerts(prevOpen, zoneState, rules, now)` trả về danh sách mở/đóng, hysteresis + cooldown (D7). **DoD:** test dao động quanh ngưỡng chỉ sinh 1 cảnh báo.
- B3.2 `adapters/notifier.ts`: Telegram + log (interface `Notifier`). **DoD:** test với notifier giả.
- B3.3 `domain/valve.ts`: máy trạng thái (D8) với `decide(zoneState, valveCtx, rules, now)` trả `Command | null` và `transition(ctx, event)`. Có `maxRunSec`, `minRestSec`, `ackTimeoutSec`, `commandId`. **DoD:** test: không tưới liên tục, không tưới khi unknown, timeout ack, dừng khi đạt ngưỡng.
- B3.4 `adapters/mqtt.ts`: publish `cmd`, subscribe `state`. **DoD:** chạy qua broker giả (interface).
- B3.5 `CommandStore` + `AlertStore` (memory/PG) theo D6. **DoD:** test ghi lệnh kèm lý do.
- B3.6 Vòng lặp Controller `tick()`: đọc twin (HTTP hoặc repo), quyết định, gửi lệnh, đánh giá cảnh báo. **DoD:** test closed loop với simulator mini: hạn hán -> cảnh báo -> tưới -> độ ẩm phục hồi -> đóng cảnh báo. (MVP M2)

## 4. Analytics (tuần 6-7)

- B4.1 `domain/waterBalance.ts`: `step(m, params, inputs)`; `simulate(m0, params, inputs[])`. **DoD:** test bảo toàn khi hệ số 0.
- B4.2 `domain/calibrate.ts`: fit hệ số bằng bình phương tối thiểu (normal equations) trên chuỗi lịch sử; ràng buộc hệ số không âm. **DoD:** test khôi phục hệ số từ dữ liệu tổng hợp có nhiễu.
- B4.3 `domain/forecast.ts`: dự đoán 1h/3h/6h dùng dự báo thời tiết (interface `WeatherProvider`, adapter Open-Meteo có cache). **DoD:** test với provider giả.
- B4.4 `domain/whatif.ts`: so sánh nhiều lịch tưới, trả quỹ đạo và chỉ số (độ ẩm min, thời gian dưới WP, tổng nước). **DoD:** test lịch tưới nhiều hơn cho độ ẩm cao hơn.
- B4.5 `domain/evaluate.ts`: MAE/RMSE, baseline persistence và linear-trend, chia train/test theo thời gian. **DoD:** script `npm run eval -w analytics` in bảng.
- B4.6 REST: `POST /forecast`, `POST /whatif`, `GET /model`. **DoD:** test HTTP.

## 5. Đóng gói và tích hợp (xuyên suốt)

- B5.1 Dockerfile multi-stage cho 3 service (giao C). **DoD:** `docker build` pass (không chạy được trong sandbox, ghi rõ).
- B5.2 Danh sách biến môi trường từng service trong `docs/api.md` (C cần).
- B5.3 Cuối mỗi mốc chạy `npm test` toàn repo và `scripts/e2e-local.ts`. **DoD:** xanh.

## 6. Thứ tự thực hiện trong phiên làm việc này

1. Workspace + shared (B1.1-1.5)
2. Twin Service domain + API (B2.1-2.7)
3. Alerts + Controller (B3.1-3.6)
4. Analytics (B4.1-4.6)
5. Dashboard JSON, Dockerfile, tài liệu, chạy toàn bộ test

## 7. Rủi ro và cách giảm

| Rủi ro | Giảm |
|---|---|
| A trễ dữ liệu | fake-feed + chế độ poll |
| Không có hạ tầng thật để test | Mọi I/O sau interface, test bằng bản memory |
| Mô hình dự đoán kém | Vẫn báo cáo so baseline; ghi giới hạn |
| Tưới lặp | D8 + test bắt buộc |
