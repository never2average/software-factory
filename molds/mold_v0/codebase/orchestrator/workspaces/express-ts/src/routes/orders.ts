import { Router } from "express";
import { createOrder, getOrder, listOrders } from "../store.js";

export const ordersRouter = Router();

ordersRouter.get("/", (_req, res) => {
  res.json(listOrders());
});

ordersRouter.get("/:id", (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  res.json(order);
});

ordersRouter.post("/", (req, res) => {
  const order = createOrder(req.body);
  res.status(201).json(order);
});
