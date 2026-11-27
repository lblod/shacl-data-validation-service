import * as env from "../env";
import { listRules, selectedFocusNodes } from "./rules";

/*
 * Validates every resource the rules target, a page of batchSize resources of
 * a rule at a time, one resource after the other: handle validates a
 * resource. A resource several rules target is handled once per run. Returns
 * the number of resources handled.
 */
export async function validateTargetedResources(
  handle: (uri: string) => Promise<void>,
  batchSize = env.TARGET_BATCH_SIZE,
): Promise<number> {
  const handled = new Set<string>();
  const rules = listRules();
  for (const rule of rules) {
    for (let offset = 0; ; offset += batchSize) {
      const page = await selectedFocusNodes(rule, { limit: batchSize, offset });
      const unhandled = page.filter((uri) => !handled.has(uri));
      for (const uri of unhandled) {
        handled.add(uri);
        // A failing resource doesn't stop the run
        try {
          await handle(uri);
        } catch (error) {
          console.error(
            `\n>> ERROR: Periodic validation of ${uri} failed:`,
            error,
          );
        }
      }
      // A shorter page is the last one
      if (page.length < batchSize) break;
    }
  }
  return handled.size;
}
