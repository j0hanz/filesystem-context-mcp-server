import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

const MAX_EVENTS_PER_STREAM = 1000;

interface StoredEvent {
  id: string;
  message: JSONRPCMessage;
}

export class InMemoryEventStore {
  // Map of streamId -> StoredEvent[]
  private streams = new Map<string, StoredEvent[]>();
  // Map of eventId -> streamId for fast lookup
  private eventIdToStreamId = new Map<string, string>();

  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = randomUUID();
    let stream = this.streams.get(streamId);

    if (!stream) {
      stream = [];
      this.streams.set(streamId, stream);
    }

    // Add new event
    stream.push({ id: eventId, message });
    this.eventIdToStreamId.set(eventId, streamId);

    // Enforce limits
    if (stream.length > MAX_EVENTS_PER_STREAM) {
      const removed = stream.shift();
      if (removed) {
        this.eventIdToStreamId.delete(removed.id);
      }
    }

    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return Promise.resolve(this.eventIdToStreamId.get(eventId));
  }

  async replayEventsAfter(
    lastEventId: string,
    callbacks: {
      send: (eventId: string, message: JSONRPCMessage) => Promise<void>;
    }
  ): Promise<string> {
    const streamId = this.eventIdToStreamId.get(lastEventId);
    if (!streamId) {
      throw new Error(`Event ID ${lastEventId} not found or expired`);
    }

    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    const eventIndex = stream.findIndex((e) => e.id === lastEventId);
    if (eventIndex === -1) {
      throw new Error(
        `Event ID ${lastEventId} not found in stream ${streamId}`
      );
    }

    // Replay all events after the found index
    for (let i = eventIndex + 1; i < stream.length; i++) {
      const event = stream[i];
      if (event) {
        await callbacks.send(event.id, event.message);
      }
    }

    return streamId;
  }

  /**
   * Cleans up all events for a given streamId.
   */
  delete(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      for (const event of stream) {
        this.eventIdToStreamId.delete(event.id);
      }
      this.streams.delete(streamId);
    }
  }

  /**
   * Cleans up all streams.
   */
  clear(): void {
    this.streams.clear();
    this.eventIdToStreamId.clear();
  }
}
