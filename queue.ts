import * as env from "./env";
import NamedNodeExt from "rdf-ext/lib/NamedNode.js";

type Handler = (subject: NamedNodeExt) => Promise<void>;

export class SubjectQueue {
  private subjects: NamedNodeExt[] = [];

  constructor(private readonly callback: Handler) {
    this.run();
  }

  enqueue(subject: NamedNodeExt) {
    const isQueuedSubject = this.subjects.find(
      (scheduledSubject) => scheduledSubject.value === subject.value,
    );

    if (!isQueuedSubject) {
      this.subjects.push(subject);
    }
  }

  get size() {
    return this.subjects.length;
  }

  private async run() {
    if (this.size > 0) {
      const nextSubject = this.subjects.shift();
      try {
        await this.callback(nextSubject);
      } catch (error) {
        console.error(
          `\n>> Error while processing resource ${nextSubject.value}`,
          error,
        );
      } finally {
        this.run();
      }
    } else {
      setTimeout(() => {
        this.run();
      }, env.QUEUE_POLL_INTERVAL);
    }
  }
}
