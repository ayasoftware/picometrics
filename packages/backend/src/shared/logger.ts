import pino from "pino";
import { config } from "../config";

export const logger = pino({
  level: config.NODE_ENV === "development" ? "debug" : "info",
  ...(config.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});
