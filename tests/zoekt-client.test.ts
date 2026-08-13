import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ZoektApiError,
  ZoektClient,
  ZoektHttpError,
  ZoektResponseError,
  ZoektTimeoutError,
} from "../src/zoekt-client.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

const openServers: ReturnType<typeof createServer>[] = [];

async function startServer(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ Error: error instanceof Error ? error.message : String(error) }));
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("ZoektClient.search", () => {
  it("maps certified content lines and preserves multiple byte ranges", async () => {
    let observedBody: unknown;
    const line = "FG_DIRECT_TOKEN FG_DIRECT_TOKEN\n";
    const baseUrl = await startServer(async (request, response) => {
      observedBody = await readJson(request);
      sendJson(response, {
        Result: {
          Crashes: 0,
          FileCount: 1,
          FilesSkipped: 0,
          FlushReason: 0,
          MatchCount: 1,
          Files: [{
            FileName: "direct.txt",
            Version: "v1",
            ChunkMatches: null,
            LineMatches: [{
              Line: Buffer.from(line).toString("base64"),
              LineStart: 10,
              LineEnd: 10 + Buffer.byteLength(line),
              LineNumber: 2,
              FileName: false,
              LineFragments: [
                { LineOffset: 0, Offset: 10, MatchLength: 15 },
                { LineOffset: 16, Offset: 26, MatchLength: 15 },
              ],
            }],
          }],
        },
      });
    });
    const result = await new ZoektClient(baseUrl).search({
      query: 'type:file case:yes content:"FG_DIRECT_TOKEN"',
      exactMatchQuery: 'case:yes content:"FG_DIRECT_TOKEN"',
      mandatoryLiteral: "FG_DIRECT_TOKEN",
    });
    expect(result.exactMatches).toEqual([{
      path: "direct.txt",
      lineNumber: 2,
      lineText: "FG_DIRECT_TOKEN FG_DIRECT_TOKEN",
      ranges: [
        { absoluteStart: 10, absoluteEnd: 25, lineStart: 0, lineEnd: 15 },
        { absoluteStart: 26, absoluteEnd: 41, lineStart: 16, lineEnd: 31 },
      ],
    }]);
    expect(observedBody).toMatchObject({
      Q: 'case:yes content:"FG_DIRECT_TOKEN"',
      Opts: {
        MaxMatchDisplayCount: 1_000_001,
        ShardMaxMatchCount: 1_000_001,
        TotalMaxMatchCount: 1_000_001,
        NumContextLines: 0,
      },
    });
  });

  it("keeps certified LF matches while reporting CR-bearing paths for coverage verification", async () => {
    const safeLine = Buffer.from("FG_DIRECT_TOKEN\n");
    const crlfLine = Buffer.from("FG_DIRECT_TOKEN\r\n");
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, {
        Result: {
          Crashes: 0,
          FileCount: 2,
          FilesSkipped: 0,
          FlushReason: 0,
          MatchCount: 2,
          Files: [
            {
              FileName: "safe.txt",
              Version: "v1",
              LineMatches: [{
                Line: safeLine.toString("base64"),
                LineStart: 0,
                LineEnd: safeLine.length,
                LineNumber: 1,
                FileName: false,
                LineFragments: [{ LineOffset: 0, Offset: 0, MatchLength: 15 }],
              }],
            },
            {
              FileName: "unsafe-crlf.txt",
              Version: "v1",
              LineMatches: [{
                Line: crlfLine.toString("base64"),
                LineStart: 20,
                LineEnd: 20 + crlfLine.length,
                LineNumber: 2,
                FileName: false,
                LineFragments: [{ LineOffset: 0, Offset: 20, MatchLength: 15 }],
              }],
            },
          ],
        },
      });
    });
    const result = await new ZoektClient(baseUrl).search({
      query: 'type:file case:yes content:"FG_DIRECT_TOKEN"',
      exactMatchQuery: 'case:yes content:"FG_DIRECT_TOKEN"',
      mandatoryLiteral: "FG_DIRECT_TOKEN",
    });
    expect(result.exactMatches).toEqual([{
      path: "safe.txt",
      lineNumber: 1,
      lineText: "FG_DIRECT_TOKEN",
      ranges: [{ absoluteStart: 0, absoluteEnd: 15, lineStart: 0, lineEnd: 15 }],
    }]);
    expect(result.exactMatchCarriageReturnPaths).toEqual(["unsafe-crlf.txt"]);
  });

  it.each([
    {
      label: "invalid UTF-8",
      line: Buffer.from([0xff, ...Buffer.from("FG_DIRECT_TOKEN\n")]),
      lineEnd: 17,
      matchCount: 1,
    },
    {
      label: "truncated match display",
      line: Buffer.from("FG_DIRECT_TOKEN\n"),
      lineEnd: 16,
      matchCount: 2,
    },
  ])("withholds exact content matches for $label responses", async ({ line, lineEnd, matchCount }) => {
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, {
        Result: {
          Crashes: 0,
          FileCount: 1,
          FilesSkipped: 0,
          FlushReason: 0,
          MatchCount: matchCount,
          Files: [{
            FileName: "unsafe.txt",
            Version: "v1",
            LineMatches: [{
              Line: line.toString("base64"),
              LineStart: 0,
              LineEnd: lineEnd,
              LineNumber: 1,
              FileName: false,
              LineFragments: [{ LineOffset: line[0] === 0xff ? 1 : 0, Offset: line[0] === 0xff ? 1 : 0, MatchLength: 15 }],
            }],
          }],
        },
      });
    });
    const result = await new ZoektClient(baseUrl).search({
      query: 'type:file case:yes content:"FG_DIRECT_TOKEN"',
      exactMatchQuery: 'case:yes content:"FG_DIRECT_TOKEN"',
      mandatoryLiteral: "FG_DIRECT_TOKEN",
    });
    expect(result.exactMatches).toBeUndefined();
    expect(result.exactMatchCarriageReturnPaths).toBeUndefined();
  });

  it("POSTs /api/search, deduplicates candidates, and maps stats", async () => {
    let observedMethod = "";
    let observedPath = "";
    let observedBody: unknown;
    const baseUrl = await startServer(async (request, response) => {
      observedMethod = request.method ?? "";
      observedPath = request.url ?? "";
      observedBody = await readJson(request);
      sendJson(response, {
        Result: {
          FilesConsidered: 14,
          FilesLoaded: 4,
          MatchCount: 7,
          Duration: 100_000,
          FileCount: 3,
          Files: [
            { FileName: "./src\\one.ts", Version: "abc123", LineMatches: [] },
            { FileName: "src/one.ts", Version: "abc123", LineMatches: [] },
            { FileName: "src/two.ts", Version: "abc123", LineMatches: [] },
          ],
        },
      });
    });

    const client = new ZoektClient({ baseUrl, maxFiles: 20 });
    const result = await client.search(String.raw`case:yes content:"a\\.b"`);
    expect(result).toMatchObject({
      files: ["src/one.ts", "src/two.ts"],
      indexedCommit: "abc123",
      baseVersionState: "consistent",
      filesConsidered: 14,
      filesLoaded: 4,
      matchCount: 7,
      serverDurationMs: 0.1,
      truncated: false,
    });
    expect(result.durationMs).toBe(result.roundTripMs);
    expect(result.durationMs).toBeGreaterThanOrEqual(result.serverDurationMs ?? Infinity);
    expect(result.jsonDecodeMs).toBeGreaterThanOrEqual(0);
    expect(result.transportSerializationMs).toBeGreaterThanOrEqual(0);
    expect(
      (result.serverDurationMs ?? 0) + result.jsonDecodeMs + result.transportSerializationMs,
    ).toBeCloseTo(result.roundTripMs, 10);
    expect(observedMethod).toBe("POST");
    expect(observedPath).toBe("/api/search");
    expect(observedBody).toEqual({
      Q: String.raw`case:yes content:"a\\.b"`,
      Opts: { MaxDocDisplayCount: 21, NumContextLines: 0 },
    });
  });

  it("caps at maxFiles and marks the sentinel response as truncated", async () => {
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, {
        Result: {
          FilesConsidered: 3,
          FilesLoaded: 3,
          MatchCount: 3,
          Duration: 100,
          Files: [
            { FileName: "a.ts", Version: "v1" },
            { FileName: "b.ts", Version: "v1" },
            { FileName: "c.ts", Version: "v1" },
          ],
        },
      });
    });
    const result = await new ZoektClient(baseUrl).search("case:yes content:\"abc\"", { maxFiles: 2 });
    expect(result.files).toEqual(["a.ts", "b.ts"]);
    expect(result.truncated).toBe(true);
  });

  it("marks server-side skip/count signals as potential truncation", async () => {
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, {
        Result: {
          FilesSkipped: 2,
          FileCount: 9,
          Files: [{ FileName: "a.ts", Version: "v1" }],
        },
      });
    });
    await expect(new ZoektClient(baseUrl).search("case:yes content:\"abc\"")).resolves.toMatchObject({
      files: ["a.ts"],
      truncated: true,
    });
  });

  it("omits indexedCommit when returned versions disagree", async () => {
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, {
        Result: {
          Files: [
            { FileName: "a.ts", Version: "v1" },
            { FileName: "b.ts", Version: "v2" },
          ],
        },
      });
    });
    const result = await new ZoektClient(baseUrl).search("case:yes content:\"abc\"");
    expect(result).not.toHaveProperty("indexedCommit");
    expect(result.baseVersionState).toBe("mixed");
  });

  it("ignores versionless overlay files when validating the base commit", async () => {
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, {
        Result: {
          Files: [
            { FileName: "a.ts", Repository: "github.com/example/base", Version: "v1" },
            { FileName: "new.ts", Repository: "fast-grep-overlay/example" },
          ],
        },
      });
    });
    await expect(new ZoektClient(baseUrl).search("case:yes content:\"abc\"")).resolves.toMatchObject({
      indexedCommit: "v1",
      baseVersionState: "consistent",
    });
  });

  it("accepts null Files", async () => {
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, { Result: { Files: null, Duration: 0 } });
    });
    await expect(new ZoektClient(baseUrl).search("case:yes content:\"none\"")).resolves.toMatchObject({
      files: [],
      truncated: false,
      serverDurationMs: 0,
    });
  });

  it("does not replace the full round trip with Zoekt's server Duration", async () => {
    const baseUrl = await startServer((_request, response) => {
      setTimeout(() => sendJson(response, {
        Result: { Files: [], Duration: 1_000_000 },
      }), 25).unref();
    });
    const result = await new ZoektClient(baseUrl).search("case:yes content:\"timed\"");
    expect(result.serverDurationMs).toBe(1);
    const serverDurationMs = result.serverDurationMs ?? 0;
    expect(result.durationMs).toBe(result.roundTripMs);
    expect(result.durationMs).toBeGreaterThanOrEqual(15);
    expect(
      result.transportSerializationMs + result.jsonDecodeMs + serverDurationMs,
    ).toBeCloseTo(
      result.roundTripMs,
      10,
    );
  });

  it("omits serverDurationMs but retains the measured decomposition when Duration is absent", async () => {
    const baseUrl = await startServer((_request, response) => {
      sendJson(response, { Result: { Files: [] } });
    });
    const result = await new ZoektClient(baseUrl).search("case:yes content:\"no-duration\"");
    expect(result).not.toHaveProperty("serverDurationMs");
    expect(result.transportSerializationMs + result.jsonDecodeMs).toBeCloseTo(
      result.roundTripMs,
      10,
    );
  });

  it("surfaces HTTP, API-wrapper, and malformed-response errors", async () => {
    const httpUrl = await startServer((_request, response) => {
      sendJson(response, { Error: "bad query" }, 400);
    });
    await expect(new ZoektClient(httpUrl).search("bad")).rejects.toBeInstanceOf(ZoektHttpError);

    const apiUrl = await startServer((_request, response) => {
      sendJson(response, { Error: "backend failed" });
    });
    await expect(new ZoektClient(apiUrl).search("bad")).rejects.toBeInstanceOf(ZoektApiError);

    const malformedUrl = await startServer((_request, response) => {
      sendJson(response, { Result: { Files: "not-an-array" } });
    });
    await expect(new ZoektClient(malformedUrl).search("bad")).rejects.toBeInstanceOf(ZoektResponseError);
  });

  it("times out a slow request", async () => {
    const baseUrl = await startServer((_request, response) => {
      setTimeout(() => sendJson(response, { Result: { Files: [] } }), 150).unref();
    });
    const client = new ZoektClient({ baseUrl, timeoutMs: 20 });
    await expect(client.search("case:yes content:\"slow\"")).rejects.toBeInstanceOf(ZoektTimeoutError);
  });

  it("keeps the timeout active while reading the response body", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"Result":');
      setTimeout(() => response.end('{"Files":[]}}'), 150).unref();
    });
    const client = new ZoektClient({ baseUrl, timeoutMs: 20 });
    await expect(client.search("case:yes content:\"slow-body\"")).rejects.toBeInstanceOf(
      ZoektTimeoutError,
    );
  });

  it("propagates caller aborts without relabeling them as timeouts", async () => {
    const baseUrl = await startServer((_request, response) => {
      setTimeout(() => sendJson(response, { Result: { Files: [] } }), 150).unref();
    });
    const controller = new AbortController();
    const client = new ZoektClient({ baseUrl, timeoutMs: 1_000 });
    const pending = client.search("case:yes content:\"abort\"", { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(ZoektTimeoutError);
  });
});

describe("ZoektClient.health", () => {
  it("GETs /healthz and requires Crashes === 0", async () => {
    const methods: string[] = [];
    const paths: string[] = [];
    let crashes = 0;
    const baseUrl = await startServer((request, response) => {
      methods.push(request.method ?? "");
      paths.push(request.url ?? "");
      sendJson(response, { Crashes: crashes });
    });
    const client = new ZoektClient(baseUrl);
    await expect(client.health()).resolves.toBe(true);
    crashes = 1;
    await expect(client.healthCheck()).resolves.toBe(false);
    expect(methods).toEqual(["GET", "GET"]);
    expect(paths).toEqual(["/healthz", "/healthz"]);
  });

  it("rejects a 200 response which lacks crash stats", async () => {
    const baseUrl = await startServer((_request, response) => sendJson(response, { ok: true }));
    await expect(new ZoektClient(baseUrl).health()).rejects.toBeInstanceOf(ZoektResponseError);
  });
});
