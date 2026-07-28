import type http from "node:http";

import { createUlid } from "../bootstrap/identifier.ts";

export const STREAM_BUFFER = 1_000;

export interface StreamEvent {
  type: "issue.changed" | "index.state" | "integrity.changed" | "resync";
  data: Record<string, unknown>;
}

interface BufferedEvent extends StreamEvent {
  seq: number;
}

/**
 * Server-sent events for change propagation (design §3.9).
 *
 * SSE rather than WebSocket because nothing flows upstream, and rather than
 * polling because a 1–2s poll would spend most of its requests answering "no
 * change" on a board that is usually idle.
 *
 * Event ids carry an epoch. A restart mints a new one, so a client holding an
 * id from a previous run is told to resync instead of being handed an empty
 * result that looks like "nothing happened since".
 */
export class EventStream {
  readonly epoch = createUlid();
  #seq = 0;
  #buffer: BufferedEvent[] = [];
  #clients = new Set<http.ServerResponse>();

  get clientCount(): number {
    return this.#clients.size;
  }

  get lastEventId(): string {
    return `${this.epoch}-${this.#seq}`;
  }

  attach(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const resumeFrom = this.#parseLastEventId(
      (request.headers["last-event-id"] as string | undefined) ?? null,
    );

    if (resumeFrom === "resync") {
      this.#send(response, {
        seq: this.#seq,
        type: "resync",
        data: { reason: "the stream restarted or the buffer moved past this client" },
      });
    } else if (resumeFrom !== null) {
      for (const event of this.#buffer.filter((entry) => entry.seq > resumeFrom)) {
        this.#send(response, event);
      }
    }

    this.#clients.add(response);
    response.on("close", () => {
      this.#clients.delete(response);
    });
  }

  publish(event: StreamEvent): void {
    this.#seq += 1;
    const buffered: BufferedEvent = { ...event, seq: this.#seq };

    this.#buffer.push(buffered);
    if (this.#buffer.length > STREAM_BUFFER) {
      this.#buffer.splice(0, this.#buffer.length - STREAM_BUFFER);
    }

    for (const client of this.#clients) {
      this.#send(client, buffered);
    }
  }

  close(): void {
    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
  }

  /**
   * Returns the sequence to resume after, or `"resync"` when the client's
   * position cannot be honoured — a different epoch, or an id older than
   * anything still buffered.
   */
  #parseLastEventId(header: string | null): number | "resync" | null {
    if (!header) {
      return null;
    }
    const separator = header.lastIndexOf("-");
    if (separator === -1) {
      return "resync";
    }

    const epoch = header.slice(0, separator);
    const seq = Number(header.slice(separator + 1));
    if (epoch !== this.epoch || !Number.isFinite(seq)) {
      return "resync";
    }

    const oldest = this.#buffer[0]?.seq;
    if (oldest !== undefined && seq < oldest - 1) {
      // The client missed events that have already been dropped; replaying
      // what is left would leave a silent hole in its view.
      return "resync";
    }
    return seq;
  }

  #send(response: http.ServerResponse, event: BufferedEvent): void {
    response.write(
      `id: ${this.epoch}-${event.seq}\n` +
        `event: ${event.type}\n` +
        `data: ${JSON.stringify(event.data)}\n\n`,
    );
  }
}
