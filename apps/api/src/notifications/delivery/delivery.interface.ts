export interface NotificationPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface DeliveryResult {
  channel: string;
  success: boolean;
  error?: string;
}

export interface IDeliveryService {
  deliver(payload: NotificationPayload): Promise<DeliveryResult>;
}
