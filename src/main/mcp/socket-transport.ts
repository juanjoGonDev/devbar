import type { Duplex } from 'node:stream';
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP over one connection of the local endpoint: the same newline-delimited
 * JSON-RPC framing as stdio (the bridge only pipes bytes), on a socket. The
 * SDK's own stdio transport would do on paper, but it never ends its stream
 * and waits forever on a write to a socket that is already gone; this one
 * closes both ways.
 */

/** A message bigger than this ends the connection (10 MB, as stdio). */
const MAX_BUFFER = 10 * 1024 * 1024;

export class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer({ maxBufferSize: MAX_BUFFER });
  private closed = false;

  constructor(private readonly stream: Duplex) {}

  start(): Promise<void> {
    this.stream.on('data', this.onData);
    this.stream.on('error', this.onStreamError);
    this.stream.on('close', this.onStreamClose);
    // The endpoint paused it while it read the hello: flow again.
    this.stream.resume();
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.stream.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      if (this.stream.write(serializeMessage(message))) resolve();
      else {
        const done = (): void => {
          this.stream.off('drain', done);
          this.stream.off('close', done);
          resolve();
        };
        this.stream.once('drain', done);
        this.stream.once('close', done);
      }
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.stream.off('data', this.onData);
    this.stream.off('error', this.onStreamError);
    this.stream.off('close', this.onStreamClose);
    this.buffer.clear();
    this.stream.end();
    this.onclose?.();
    return Promise.resolve();
  }

  private readonly onData = (chunk: Buffer): void => {
    try {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (error) {
          this.onerror?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  };

  private readonly onStreamError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly onStreamClose = (): void => {
    void this.close();
  };
}
