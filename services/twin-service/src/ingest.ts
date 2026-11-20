import { Kafka } from "kafkajs";
import { KAFKA_TOPICS, Reading } from "@farm/shared";
import type { TwinService } from "./service";

/** Consumer Kafka telemetry.clean -> TwinService. Message hỏng bị bỏ qua, không làm sập consumer. */
export async function startKafkaIngest(service: TwinService, brokers: string[], groupId = "twin-service") {
  const kafka = new Kafka({ clientId: "twin-service", brokers });
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_TOPICS.clean, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const parsed = Reading.safeParse(JSON.parse(message.value?.toString() ?? "null"));
        if (parsed.success) await service.ingest(parsed.data);
      } catch { /* JSON hỏng: bỏ qua */ }
    },
  });
  return () => consumer.disconnect();
}
