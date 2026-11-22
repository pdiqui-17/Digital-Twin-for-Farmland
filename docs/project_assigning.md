# Phân công và quy trình làm việc: Digital Twin cho Farmland

Tài liệu này dành cho nhóm 3 người, thời gian 8 tuần (có thể co giãn, xem mục 9). Mỗi người sở hữu một mảng, nhưng cả ba mảng phải ráp lại chạy được end-to-end sau mỗi mốc.

Stack thống nhất: Node.js/TypeScript (Express) cho các service, MQTT (Mosquitto), Kafka, PostgreSQL + TimescaleDB, MinIO, Docker, Kubernetes (k3s), Helm, Prometheus + Grafana, GitHub Actions.

---

## 1. Tổng quan ba role

| Role | Tên | Trách nhiệm chính | Sở hữu |
|---|---|---|---|
| A | Data & Pipeline | Tạo dữ liệu và đưa dữ liệu vào hệ thống, lưu trữ | `services/simulator`, `services/processor`, `db/` |
| B | Twin Core | Trạng thái twin, phân tích, điều khiển, cảnh báo, dashboard nghiệp vụ | `services/twin-service`, `services/analytics`, `services/controller` |
| C | Cloud & Platform | Container, Kubernetes, scaling, bảo mật, giám sát, CI/CD, đo đạc | `deploy/`, `monitoring/`, `load-test/`, `.github/` |

Thư mục `packages/shared` và `docs/` là của chung. Mọi thay đổi trong `packages/shared` phải được cả nhóm xem qua (xem mục 3).

Gợi ý chọn role: người đang học Kubernetes nên nhận role C, vì đây là phần môn Cloud Computing chấm điểm nhiều nhất và cần thời gian học dài nhất.

---

## 2. Cấu trúc repo (monorepo)

```
digital-twin-farm/
├── services/
│   ├── simulator/        # A: "thế giới thực", publish MQTT
│   ├── processor/        # A: Kafka -> làm sạch -> ghi DB/MinIO
│   ├── twin-service/     # B: REST + WebSocket, giữ trạng thái twin
│   ├── analytics/        # B: dự đoán, what-if
│   └── controller/       # B: luật tưới, lệnh MQTT, cảnh báo
├── packages/
│   └── shared/           # chung: schema zod, kiểu dữ liệu, tên topic, logger, metrics
├── db/
│   ├── migrations/       # A: SQL schema, hypertable, retention
│   └── seed/             # A: farm, zone, sensor khởi tạo
├── deploy/
│   ├── docker-compose.yml  # C: chạy local
│   └── helm/               # C: chart từng service + hạ tầng
├── monitoring/           # C: dashboard Grafana (JSON), rule Prometheus
├── load-test/            # C (A hỗ trợ): kịch bản tăng tải
├── docs/                 # chung: thiết kế, sơ đồ, số liệu đo, báo cáo
└── .github/workflows/    # C: CI/CD
```

Cấu trúc bên trong mỗi service (thống nhất để dễ đọc):

```
<service>/
├── src/
│   ├── config.ts         # đọc biến môi trường
│   ├── routes/           # (nếu có API)
│   ├── domain/           # logic nghiệp vụ
│   ├── repositories/     # truy cập DB (chỉ service sở hữu bảng được ghi)
│   └── index.ts
├── Dockerfile
└── package.json
```

Mỗi service bắt buộc có: `/healthz`, `/readyz`, `/metrics` (prom-client), cấu hình hoàn toàn qua biến môi trường.

---

## 3. Hợp đồng chung (chốt trong tuần 1, đặt ở `packages/shared`)

Đây là chỗ dễ lệch nhất giữa các role. Sửa thì phải báo cả nhóm.

### 3.1. MQTT topic

| Mục đích | Topic |
|---|---|
| Dữ liệu cảm biến | `farm/{farmId}/zone/{zoneId}/sensor/{sensorId}/telemetry` |
| Trạng thái actuator (phản hồi) | `farm/{farmId}/zone/{zoneId}/actuator/valve/state` |
| Lệnh điều khiển | `farm/{farmId}/zone/{zoneId}/actuator/valve/cmd` |

### 3.2. Kafka topic

| Topic | Nội dung | Producer | Consumer |
|---|---|---|---|
| `telemetry.raw` | Message cảm biến thô từ MQTT | Bridge/Processor | Processor |
| `telemetry.clean` | Dữ liệu đã làm sạch, gắn cờ chất lượng | Processor | Twin Service, Analytics |
| `alerts` | Sự kiện cảnh báo (có vòng đời open/closed) | Controller | Grafana, service khác nếu cần |

### 3.3. Bảng cơ sở dữ liệu và quyền ghi

| Bảng | Loại | Service được ghi | Service được đọc |
|---|---|---|---|
| `farms`, `zones`, `sensors`, `actuators` | Postgres thường | seed (A) | tất cả |
| `sensor_readings` | Hypertable (Timescale) | Processor | Twin Service, Analytics, Grafana |
| `twin_state` (JSONB) | Postgres thường | Twin Service | Controller, Analytics, Grafana |
| `commands` | Postgres thường | Controller | Twin Service, Grafana |
| `alerts` | Postgres thường | Controller | Grafana |

Nguyên tắc: mỗi bảng chỉ một service được ghi. Service khác chỉ đọc hoặc gọi API.
Riêng `alerts` (nhóm đã duyệt): Twin Service không ghi; cảm biến lỗi được đưa vào `twin_state.state.faultySensors` và Controller sinh cảnh báo `sensor_fault`. Cột `rule`, `closed_at` thêm ở migration 005.

### 3.4. Schema message cảm biến (ví dụ)

```json
{
  "sensorId": "s-A1",
  "zoneId": "zone-A",
  "type": "soil_moisture",
  "value": 38.5,
  "unit": "percent",
  "ts": "2026-01-01T08:00:00Z",
  "quality": "ok"
}
```

Kiểu thực thể Farm, Zone, Sensor, Actuator được viết bằng TypeScript interface kèm schema `zod`.

---

## 4. Role A: Data & Pipeline

### 4.1. Việc cần làm

- Simulator: mô hình "thực tế" của nông trại, gồm chu kỳ ngày/đêm, bay hơi, ảnh hưởng của tưới và mưa, nhiễu, lỗi sensor (mất tín hiệu, lệch giá trị), kịch bản hạn hán bật/tắt được. Tích hợp thời tiết lịch sử từ Open-Meteo làm môi trường ngoài. Có biến môi trường để nhân bản nhiều sensor ảo.
- Simulator giả lập van tưới: nhận lệnh từ MQTT, đổi trạng thái, ảnh hưởng ngược lên độ ẩm đất, phát lại trạng thái.
- Processor: nhận từ MQTT, đẩy vào Kafka, consume, kiểm tra bằng schema, lọc nhiễu, chuẩn hóa đơn vị, phát hiện sensor lỗi, ghi vào TimescaleDB, lưu bản thô lên MinIO.
- Cơ sở dữ liệu: migration SQL, hypertable, retention, nén, dữ liệu seed.

### 4.2. Pipeline 8 tuần

| Tuần | Công việc | Kết quả kiểm tra được (Definition of Done) |
|---|---|---|
| 1 | Cùng nhóm chốt hợp đồng ở mục 3. Viết simulator cơ bản (1 zone, 3 loại sensor, publish MQTT, chu kỳ ngày/đêm, nhiễu) | `docker compose up` thấy message đều đặn trên MQTT |
| 2 | Mở rộng 4 zone. Viết Processor: MQTT -> Kafka -> consume -> ghi `sensor_readings`. Viết migration đầu tiên | Dữ liệu từ simulator xuất hiện trong TimescaleDB |
| 3 | Validate bằng zod, lọc nhiễu, phát hiện sensor lỗi (đứng giá trị, ngoài khoảng hợp lệ, mất tín hiệu). Seed farm/zone/sensor. Kịch bản hạn hán | Bật kịch bản hạn hán thì độ ẩm giảm rõ; sensor lỗi bị gắn cờ `quality` |
| 4 | Lưu bản thô lên MinIO, chính sách retention và nén trong Timescale. Cùng C đóng gói image cho simulator/processor | Hai service chạy được trên k3s; dữ liệu cũ bị nén hoặc xóa theo chính sách |
| 5 | Van tưới ảo hoàn chỉnh (nhận lệnh, phản hồi trạng thái, tác động lên độ ẩm). Hỗ trợ B thử closed loop | Gửi lệnh tưới thì độ ẩm trong dữ liệu tăng lên |
| 6 | Mở rộng simulator: tham số số lượng sensor ảo, replica. Bổ sung kịch bản (mất kết nối, lệch giá trị) | Chạy được 500+ sensor ảo mà không lỗi |
| 7 | Cùng C chạy load test, ghi nhận throughput, độ trễ qua pipeline, nút thắt cổ chai | Có số liệu và biểu đồ cho phần pipeline |
| 8 | Viết phần báo cáo của mình, sửa lỗi, hỗ trợ video demo | Báo cáo mục pipeline và lưu trữ hoàn tất |

### 4.3. Cần từ người khác

- Từ C: docker-compose có Mosquitto, Kafka, TimescaleDB (tuần 1); chart Helm cho hạ tầng (tuần 4).
- Từ B: danh sách các chỉ số B cần Processor chuẩn hóa sẵn (tuần 2).

### 4.4. Phần báo cáo của role A

Pipeline thu thập, xử lý bất đồng bộ, mô hình sinh dữ liệu mô phỏng, thiết kế lưu trữ đa tầng và retention.

---

## 5. Role B: Twin Core

### 5.1. Việc cần làm

- Twin Service: giữ trạng thái từng zone trong `twin_state`; REST API truy vấn trạng thái và lịch sử; WebSocket hoặc SSE đẩy cập nhật; tính chỉ số dẫn xuất (stress nước, nguy cơ nấm).
- Analytics: mô hình cân bằng nước đơn giản `độ ẩm(t+1) = độ ẩm(t) - bay hơi + tưới + mưa`, hiệu chỉnh hệ số từ dữ liệu lịch sử; dự đoán độ ẩm vài giờ tới; what-if (chạy lại mô hình với lịch tưới khác); tích hợp dự báo thời tiết.
- Controller: luật tưới dựa trên trạng thái và dự đoán; gửi lệnh qua MQTT; chống lặp lệnh (không tưới liên tục, có thời gian chờ); cảnh báo Telegram/Email.
- Dashboard: Grafana cho dữ liệu cảm biến và trạng thái twin, lưới zone đổi màu theo trạng thái.

Lưu ý: mô hình trong Analytics phải là bản xấp xỉ đơn giản, không copy công thức từ simulator của A. Nếu giống hệt thì sai số dự đoán sẽ đẹp một cách giả tạo.

### 5.2. Pipeline 8 tuần

| Tuần | Công việc | Kết quả kiểm tra được (Definition of Done) |
|---|---|---|
| 1 | Cùng nhóm chốt hợp đồng ở mục 3. Viết schema twin (zod + TypeScript) trong `packages/shared`. Thiết kế danh sách API | Tài liệu API và schema được cả nhóm duyệt |
| 2 | Khởi tạo Twin Service: kết nối DB, đọc/ghi `twin_state` từ dữ liệu `telemetry.clean` (hoặc đọc trực tiếp bảng khi Kafka chưa sẵn sàng) | `GET /zones/:id` trả về trạng thái cập nhật theo dữ liệu |
| 3 | Hoàn thiện REST, thêm WebSocket/SSE, tính stress nước và nguy cơ nấm. Dựng dashboard Grafana đầu tiên | Dashboard hiển thị trạng thái 4 zone gần thời gian thực |
| 4 | Cảnh báo: rule ngưỡng, gửi Telegram/Email, lưu bảng `alerts`. Bắt đầu Controller (luật ngưỡng đơn giản) | Bật hạn hán thì nhận được thông báo |
| 5 | Controller hoàn chỉnh: gửi lệnh MQTT, nhận phản hồi, chống lặp lệnh. Test closed loop cùng A | MVP: hạn hán -> cảnh báo -> tự tưới -> độ ẩm phục hồi |
| 6 | Analytics: mô hình cân bằng nước, dự đoán, what-if. Tích hợp thời tiết. Controller dùng dự đoán | API what-if trả kết quả cho 2 lịch tưới khác nhau |
| 7 | Đo độ chính xác dự đoán (MAE/RMSE so với baseline đơn giản). Đo độ trễ end-to-end cùng C | Có bảng MAE/RMSE và độ trễ |
| 8 | Viết phần báo cáo của mình, hoàn thiện dashboard, chuẩn bị kịch bản demo | Báo cáo mục twin và phân tích hoàn tất |

### 5.3. Cần từ người khác

- Từ A: dữ liệu sạch trong `sensor_readings` và Kafka (tuần 2–3); van tưới ảo (tuần 5).
- Từ C: pipeline build image, namespace Kubernetes, Grafana có sẵn để import dashboard (tuần 3–4).

### 5.4. Phần báo cáo của role B

Mô hình twin (entity, thuộc tính, mức Model/Shadow/Twin), mô hình phân tích và dự đoán, thiết kế vòng điều khiển closed loop.

---

## 6. Role C: Cloud & Platform

### 6.1. Việc cần làm

- Môi trường chạy local: docker-compose cho Mosquitto, Kafka, TimescaleDB, MinIO.
- Đóng gói: Dockerfile cho từng service (multi-stage, image nhỏ), probe `/healthz` `/readyz`.
- Kubernetes: k3s, manifest/Helm chart cho từng service và hạ tầng, ConfigMap, Secret, Ingress, PersistentVolume.
- Scaling và chịu lỗi: nhiều replica, HPA cho Processor và Twin Service, thử xóa pod.
- Bảo mật: TLS cho MQTT và API, xác thực thiết bị (chứng chỉ hoặc token), RBAC, quản lý secret.
- Quan sát: Prometheus, Grafana hạ tầng, metrics tùy chỉnh (độ trễ, số message/giây), log tập trung (tùy chọn).
- CI/CD: GitHub Actions build image, chạy test, deploy.
- Đánh giá thực nghiệm: load test, scalability, fault tolerance, hiệu quả edge (nếu làm), phân tích chi phí.

### 6.2. Pipeline 8 tuần

| Tuần | Công việc | Kết quả kiểm tra được (Definition of Done) |
|---|---|---|
| 1 | Khởi tạo repo, cấu trúc thư mục, CI cơ bản. docker-compose có MQTT + Timescale + Kafka. Học Docker và các khái niệm K8s cơ bản, deploy một service mẫu lên k3s | `docker compose up` chạy được hạ tầng; có service mẫu chạy trên k3s |
| 2 | Dockerfile cho mọi service hiện có, thêm `/healthz`. Học Deployment, Service, ConfigMap | Mọi service build được image và chạy trong docker-compose |
| 3 | Bắt đầu viết manifest/Helm cho hạ tầng (MQTT, Timescale, Kafka). Dựng Grafana trong cluster | Hạ tầng chạy trong k3s với PersistentVolume |
| 4 | Chuyển toàn bộ hệ thống lên k3s bằng Helm. Ingress, Secret, ConfigMap. Deploy lên VM cloud thật | Hệ thống end-to-end chạy trên K8s trên cloud |
| 5 | Bảo mật: TLS cho MQTT/API, xác thực thiết bị, RBAC. CI/CD tự build và deploy | Thiết bị không có chứng chỉ không kết nối được; push code thì tự deploy |
| 6 | Prometheus + metrics tùy chỉnh, dashboard hạ tầng. HPA cho Processor và Twin Service. Liveness/readiness probe | Tăng tải thì số pod tăng tự động |
| 7 | Thực nghiệm: load test (cùng A), scalability, xóa pod, đo thời gian phục hồi, phân tích chi phí. Có thể thêm edge gateway | Số liệu và biểu đồ cho tất cả chỉ số ở mục 8 |
| 8 | Viết phần báo cáo của mình, quay video demo, kiểm tra deploy từ đầu | Báo cáo mục kiến trúc cloud và đánh giá hoàn tất; video demo xong |

### 6.3. Cần từ người khác

- Từ A và B: danh sách biến môi trường và cổng của từng service; image chạy được.
- Từ B: các metrics nghiệp vụ muốn hiển thị trên Prometheus.

### 6.4. Phần báo cáo của role C

Mô hình dịch vụ IaaS/PaaS/SaaS, microservices và container, scalability, chịu lỗi, bảo mật, observability, IaC/CI-CD, phân tích chi phí, đánh giá thực nghiệm.

---

## 7. Mốc cả nhóm

| Mốc | Cuối tuần | Điều kiện đạt |
|---|---|---|
| M0 | 1 | Hợp đồng chung chốt, repo và docker-compose chạy hạ tầng, simulator publish được |
| M1 | 3 | Dữ liệu chảy từ simulator tới dashboard, chạy bằng docker-compose |
| M2 | 5 | MVP: closed loop hoàn chỉnh, hệ thống chạy trên K8s, có bảo mật cơ bản |
| M3 | 6 | Các tính năng "nên có" (dự đoán, what-if, HPA, observability) |
| M4 | 7 | Đủ số liệu thực nghiệm; dừng thêm tính năng |
| Nộp | 8 | Báo cáo, slide, video demo, mã nguồn |

---

## 8. Quy trình làm việc chung

1. **Họp ngắn đầu tuần (15 phút):** mỗi người nói tuần này làm gì và cần gì từ người khác.
2. **Tích hợp cuối tuần (khoảng 30 phút):** cả nhóm chạy thử toàn hệ thống, ghi lại những gì hỏng vào danh sách lỗi. Lỗi tích hợp phát hiện ở tuần 7 thường không kịp sửa.
3. **Git:** nhánh `main` luôn chạy được. Mỗi người làm trên nhánh riêng theo mẫu `a/ten-viec`, `b/ten-viec`, `c/ten-viec`, merge bằng pull request có ít nhất một người khác xem qua. Thay đổi trong `packages/shared` cần cả hai người còn lại đồng ý.
4. **Quy ước commit:** `feat:`, `fix:`, `docs:`, `chore:` kèm tên service.
5. **Dừng thêm tính năng từ đầu tuần 7.** Từ đó chỉ sửa lỗi, đo đạc và viết báo cáo.
6. **Viết báo cáo song song.** Mỗi người viết phần của mình ngay khi xong mảng đó (xem mục 4.4, 5.4, 6.4). Chụp số liệu và vẽ sơ đồ ngay lúc làm.
7. **Kịch bản demo** (từ tài liệu đề xuất Phase 1) là bài kiểm tra tích hợp cuối: chạy hệ thống, kích hoạt hạn hán, cảnh báo, tự tưới, what-if, tăng tải để autoscale, xóa pod để tự phục hồi.

---

## 9. Co giãn phạm vi

### 9.1. Nếu bị trễ, cắt từ dưới lên

1. Hiển thị sơ đồ zone, tối ưu lịch tưới (đã là phần mở rộng).
2. Edge gateway và MinIO.
3. Mô hình ML (thay bằng luật hoặc dự đoán tuyến tính).
4. What-if và tích hợp thời tiết.
5. Giữ đến cùng: pipeline, twin state, dashboard, cảnh báo, closed loop, chạy trên K8s, ít nhất một thí nghiệm (autoscaling hoặc xóa pod).

### 9.2. Nếu chỉ có 2 người

- Người 1: role A và phần Twin Service, Controller của B.
- Người 2: role C và phần Analytics, cảnh báo, dashboard của B.
- Cắt MinIO, edge gateway và mô hình ML khỏi phạm vi chính.

### 9.3. Nếu chỉ có 6 tuần

Nén tuần 1–2 thành một tuần, gộp tuần 6–7 thành một tuần, giữ nguyên các mốc M0 đến M2.

---

## 10. Checklist trước khi nộp

- [ ] Hệ thống dựng lại được từ đầu bằng một lệnh (Helm hoặc script) trên môi trường sạch
- [ ] Kịch bản demo chạy trơn tru, có video dự phòng
- [ ] Mọi service có `/healthz`, `/readyz`, `/metrics`
- [ ] Không có secret hoặc mật khẩu trong repo
- [ ] Có số liệu cho: độ trễ end-to-end, throughput, scalability, fault tolerance, chất lượng dự đoán
- [ ] Báo cáo ghi rõ dữ liệu là mô phỏng và mô tả mô hình sinh dữ liệu
- [ ] README ở thư mục gốc có hướng dẫn chạy local và deploy
- [ ] Slide và video demo hoàn tất
