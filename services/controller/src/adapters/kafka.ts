import { Kafka, type Producer } from "kafkajs";
import { KAFKA_TOPICS, type TwinAlertEvent } from "@digital-twin/shared";
import type { AlertPublisher } from "./ports";

export class KafkaAlertPublisher implements AlertPublisher {
  private producer: Producer;
  private connected: Promise<void>;
  constructor(brokers: string[]) {
    this.producer = new Kafka({ clientId: "controller", brokers }).producer();
    this.connected = this.producer.connect();
  }
  async publish(e: TwinAlertEvent) {
    await this.connected;
    await this.producer.send({ topic: KAFKA_TOPICS.ALERTS, messages: [{ key: e.zoneId, value: JSON.stringify(e) }] });
  }
}
