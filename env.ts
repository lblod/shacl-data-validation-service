import envvar from "env-var";

export const LOGLEVEL = envvar
  .get("LOGLEVEL")
  .default("silent")
  .asEnum(["info", "silent"]);
