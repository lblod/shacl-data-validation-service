import envvar from "env-var";

export const LOGLEVEL = envvar
  .get("LOGLEVEL")
  .default("silent")
  .asEnum(["info", "silent"]);

export const QUEUE_POLL_INTERVAL = envvar
  .get("QUEUE_POLL_INTERVAL")
  .default(100)
  .asIntPositive();
