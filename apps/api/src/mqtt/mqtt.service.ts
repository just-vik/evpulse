import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import mqtt, { MqttClient, IClientOptions } from 'mqtt';

type MessageHandler = (topic: string, msg: Buffer) => void;

@Injectable()
export class MqttService implements OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient;
  private readonly subscriptions = new Map<string, MessageHandler>();

  constructor() {
    const url = process.env.MQTT_URL || 'mqtt://mqtt:1883';

    const options: IClientOptions = {
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      keepalive: 60,
      clean: true,
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASSWORD,
    };

    this.client = mqtt.connect(url, options);

    this.client.on('connect', () => {
      this.logger.log('MQTT connected');
      // Восстанавливаем подписки после переподключения
      for (const topic of this.subscriptions.keys()) {
        this.client.subscribe(topic, (err) => {
          if (err) this.logger.error(`Failed to re-subscribe to ${topic}: ${err.message}`);
        });
      }
    });

    this.client.on('reconnect', () => {
      this.logger.warn('MQTT reconnecting...');
    });

    this.client.on('error', (err) => {
      this.logger.error(`MQTT error: ${err.message}`);
    });

    this.client.on('offline', () => {
      this.logger.warn('MQTT client offline');
    });

    // Единый глобальный обработчик — роутит по зарегистрированным подпискам
    this.client.on('message', (topic: string, msg: Buffer) => {
      for (const [pattern, handler] of this.subscriptions.entries()) {
        if (this.topicMatches(pattern, topic)) {
          try {
            handler(topic, msg);
          } catch (err: any) {
            this.logger.error(`MQTT handler error for topic ${topic}: ${err.message}`);
          }
        }
      }
    });
  }

  publish(topic: string, message: string, options?: mqtt.IClientPublishOptions): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.client.connected) {
        return reject(new Error('MQTT client not connected'));
      }
      this.client.publish(topic, message, options ?? {}, (err) => {
        if (err) reject(err);
        else resolve(true);
      });
    });
  }

  /**
   * Подписаться на топик. Повторный вызов с тем же топиком заменяет обработчик
   * (нет утечки listeners).
   */
  async subscribe(topic: string, handler: MessageHandler): Promise<void> {
    this.subscriptions.set(topic, handler);

    // Best-effort subscribe — the handler map is already registered,
    // so if the broker is not reachable right now the topic will be
    // re-subscribed automatically on the next 'connect' event.
    if (this.client.connected) {
      this.client.subscribe(topic, (err) => {
        if (err) this.logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
      });
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      this.client.end(true);
    }
  }

  /**
   * Простое сопоставление MQTT-топиков (поддерживает + и #).
   */
  private topicMatches(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') return true;
      if (patternParts[i] !== '+' && patternParts[i] !== topicParts[i]) return false;
    }
    return patternParts.length === topicParts.length;
  }
}
