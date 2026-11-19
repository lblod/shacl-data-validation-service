import envvar from "env-var";

export const LOGLEVEL = envvar
  .get("LOGLEVEL")
  .default("silent")
  .asEnum(["info", "silent"]);

export const QUEUE_POLL_INTERVAL = envvar
  .get("QUEUE_POLL_INTERVAL")
  .default(100)
  .asIntPositive();

// The maximum number of resources a rule selects at a time
export const FOCUS_NODE_LIMIT = envvar
  .get("FOCUS_NODE_LIMIT")
  .default(100)
  .asIntPositive();

// The cron expression of the periodic validation of the resources the rules
// target, e.g. "0 2 * * *". Without it, resources are only validated on delta
// messages.
export const CRON_SCHEDULE = envvar.get("CRON_SCHEDULE").asString();

// The number of resources a rule selects at a time for the periodic validation
export const BATCH_SIZE = envvar.get("BATCH_SIZE").default(100).asIntPositive();

export const ENABLE_TEST_API = envvar
  .get("ENABLE_TEST_API")
  .default("false")
  .asBool();
