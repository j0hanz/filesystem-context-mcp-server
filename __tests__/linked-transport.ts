import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';

class LinkedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private peer: LinkedTransport | undefined;
  private closed = false;

  static createLinkedPair(): [LinkedTransport, LinkedTransport] {
    const left = new LinkedTransport();
    const right = new LinkedTransport();
    left.peer = right;
    right.peer = left;
    return [left, right];
  }

  async start(): Promise<void> {
    // No-op: both sides are already wired together in memory.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = undefined;
    this.onclose?.();
    if (peer) {
      peer.peer = undefined;
      if (!peer.closed) {
        peer.closed = true;
        peer.onclose?.();
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.peer || this.peer.closed) {
      throw new Error('Transport is closed');
    }

    queueMicrotask(() => {
      if (!this.peer || this.peer.closed) return;
      try {
        this.peer.onmessage?.(structuredClone(message));
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.onerror?.(normalized);
        this.peer.onerror?.(normalized);
      }
    });
  }
}

export { LinkedTransport };
