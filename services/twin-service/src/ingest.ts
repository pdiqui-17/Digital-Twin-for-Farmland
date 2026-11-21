import { Kafka } from "kafkajs";
import { CleanTelemetryMessageSchema, KAFKA_TOPICS } from "@digital-twin/shared";
import type { TwinService } from "./service";

/**
 * Consumer Kafka telemetry.clean -> TwinService.
 * Message hỏng (JSON/schema) bị bỏ qua và đếm. Lỗi xử lý (ví dụ DB sập) được ném ra
 * để kafkajs không commit offset và giao lại message, tránh mất dữ liệu.
 */
export async function startKafkaIngest(
  service: TwinService,
  opts: { brokers: string[]; clientId: string; groupId: string; onInvalid?: () => void },
) {
  const kafka = new Kafka({ clientId: opts.clientId, brokers: opts.brokers });
  const consumer = kafka.consumer({ groupId: opts.groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.TELEMETRY_CLEAN, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      let body: unknown;
      try { body = JSON.parse(message.value?.toString() ?? "null"); } catch { opts.onInvalid?.(); return; }
      const parsed = CleanTelemetryMessageSchema.safeParse(body);
      if (!parsed.success) { opts.onInvalid?.(); return; }
      await service.ingest(parsed.data);
    },
  });
  return () => consumer.disconnect();
}
