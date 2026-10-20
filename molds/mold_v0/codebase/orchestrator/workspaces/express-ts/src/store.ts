import { randomUUID } from "node:crypto";

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  customerEmail: string;
  items: OrderItem[];
  total: number;
  createdAt: string;
}

const orders = new Map<string, Order>();

export function listOrders(): Order[] {
  return [...orders.values()];
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function createOrder(input: any): Order {
  const items: OrderItem[] = input.items ?? [];
  const order: Order = {
    id: randomUUID(),
    customerEmail: input.customerEmail,
    items,
    total: items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}
