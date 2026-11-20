import { Kafka, type Producer } from "kafkajs";
import { KAFKA_TOPICS, type AlertEvent } from "@farm/shared";
import type { AlertPublisher } from "./ports";

export class KafkaAlertPublisher implements AlertPublisher {
  private producer: Producer;
  private connected: Promise<void>;
  constructor(brokers: string[]) {
    this.producer = new Kafka({ clientId: "controller", brokers }).producer();
    this.connected = this.producer.connect();
  }
  async publish(e: AlertEvent) {
    await this.connected;
    await this.producer.send({ topic: KAFKA_TOPICS.alerts, messages: [{ key: e.zoneId, value: JSON.stringify(e) }] });
  }
}
