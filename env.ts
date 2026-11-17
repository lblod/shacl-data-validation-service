import envvar from "env-var";

export const LOGLEVEL = envvar
  .get("LOGLEVEL")
  .default("silent")
  .asEnum(["info", "silent"]);

export const QUEUE_POLL_INTERVAL = envvar
  .get("QUEUE_POLL_INTERVAL")
  .default(100)
  .asIntPositive();

// Whether reports also hold a result for each passed validation, with severity
// shn:Debug, and resources that conform get a report too
export const REPORT_DEBUG_RESULTS = envvar
  .get("REPORT_DEBUG_RESULTS")
  .default("false")
  .asBool();

export const ENABLE_TEST_API = envvar
  .get("ENABLE_TEST_API")
  .default("false")
  .asBool();
