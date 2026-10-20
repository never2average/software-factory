import express from "express";
import { ordersRouter } from "./routes/orders.js";

export const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/orders", ordersRouter);

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`orders-service listening on :${port}`));
}
