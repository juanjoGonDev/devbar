import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { SocketTransport } from '../src/main/mcp/socket-transport.js';
import { collect, duplexPair, tick } from './helpers/duplex-pair.js';

const PING: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };

async function started() {
  const [server, client] = duplexPair();
  const transport = new SocketTransport(server);
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  let closed = 0;
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  transport.onclose = () => {
    closed += 1;
  };
  await transport.start();
  return { transport, server, client, messages, errors, closed: () => closed };
}

describe('src/main/mcp/socket-transport.ts', () => {
  it('reads one message per line, even split across chunks', async () => {
    const h = await started();
    const line = JSON.stringify(PING) + '\n';

    h.client.write(line.slice(0, 10));
    h.client.write(line.slice(10) + line);
    await tick();

    expect(h.messages).toEqual([PING, PING]);
  });

  it('reports a malformed line and keeps reading', async () => {
    const h = await started();

    h.client.write('not json\n' + JSON.stringify(PING) + '\n');
    await tick();

    expect(h.errors).toHaveLength(1);
    expect(h.messages).toEqual([PING]);
  });

  it('writes each message as one line', async () => {
    const h = await started();
    const read = collect(h.client);

    await h.transport.send(PING);
    await tick();

    expect(read()).toBe(JSON.stringify(PING) + '\n');
  });

  it('closes once, ending the stream', async () => {
    const h = await started();
    let ended = false;
    h.client.on('end', () => {
      ended = true;
    });
    h.client.resume();

    await h.transport.close();
    await h.transport.close();
    await tick();

    expect(h.closed()).toBe(1);
    expect(ended).toBe(true);
  });

  it('closes when the other side hangs up', async () => {
    const h = await started();

    h.client.destroy();
    await tick();

    expect(h.closed()).toBe(1);
  });

  it('drops a send once closed instead of waiting forever', async () => {
    const h = await started();
    await h.transport.close();

    await expect(h.transport.send(PING)).resolves.toBeUndefined();
  });
});
