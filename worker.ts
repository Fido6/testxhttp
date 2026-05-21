// @ts-nocheck
// Cloudflare Workers + Durable Objects port of deno.ts
// - Keeps the same protocol: GET establishes downstream, POST uploads packet fragments with seq
// - Parses first packet header (seq=0) and opens a TCP connection using cloudflare:sockets
// - Supports optional reverse-proxy / HTTP CONNECT / SOCKS5 upstreams via PROXY_URL
// - Removes subscription output route as requested

import { connect } from "cloudflare:sockets";

const ADDRESS_TYPE_IPV4 = 1;
const ADDRESS_TYPE_STRING = 2;
const ADDRESS_TYPE_IPV6 = 3;

const SOCKS5_VERSION = 5;
const SOCKS5_CMD_CONNECT = 1;
const SOCKS5_ATYP_IPV4 = 1;
const SOCKS5_ATYP_DOMAIN = 3;
const SOCKS5_ATYP_IPV6 = 4;

/** @type {ReturnType<typeof connect>} */
type Socket = ReturnType<typeof connect>;
/** @type {Uint8Array} */
type Bytes = Uint8Array;

type ProxyMode = "direct" | "http" | "socks5";

type ProxyConfig = {
  mode: ProxyMode;
  host: string;
  port: number | null;
  tls: boolean;
  username?: string;
  password?: string;
};

type TunnelConnection = {
  socket: Socket;
  readable: ReadableStream<Bytes>;
  writable: WritableStream<Bytes>;
};

type Settings = {
  seed: string;
  pathSeg: string;
  proxyUrl: string;
  maxBufferedPosts: number;
  sessionTimeout: number;
  maxPostSize: number;
};

type FirstPktMeta = {
  hostname: string;
  port: number;
  data: Bytes;
  resp: Bytes;
};

export interface Env {
  K_SIGIL?: string;
  P_SIGIL?: string;
  PROXY_URL?: string;
  PORT?: string; // unused in workers, kept for compatibility
  LOG_LEVEL?: string;

  // Durable Object binding
  NEST: DurableObjectNamespace<SessionDO>;
}

function getSettings(env: Env): Settings {
  return {
    seed: env.K_SIGIL || "58888888-8888-8888-8888-888888888888",
    pathSeg: env.P_SIGIL || "xhttp",
    proxyUrl: env.PROXY_URL?.trim() || "",
    maxBufferedPosts: 30,
    sessionTimeout: 30_000,
    maxPostSize: 1_000_000,
  };
}

function logEnabled(env: Env): boolean {
  const level = (env.LOG_LEVEL ?? "debug").toLowerCase();
  return level !== "silent" && level !== "none";
}

function log(env: Env, ...args: unknown[]): void {
  if (!logEnabled(env)) return;
  console.log(...args);
}

function randomPadding(min: number, max: number): string {
  const length = min + Math.floor(Math.random() * (max - min));
  return btoa("X".repeat(length));
}

function baseHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    "X-Padding": randomPadding(100, 1000),
  };
}

function withHeaders(resp: Response, extra?: HeadersInit): Response {
  const headers = new Headers(resp.headers);
  const common = baseHeaders();
  for (const [key, value] of Object.entries(common)) {
    headers.set(key, String(value));
  }
  if (extra) {
    const more = new Headers(extra);
    more.forEach((value, key) => headers.set(key, value));
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function concatBytes(...parts: Bytes[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseUuid(uuid: string): Bytes {
  const compact = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function validateUuid(left: Bytes, right: Bytes): boolean {
  for (let i = 0; i < 16; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function readStreamExactly(
  reader: ReadableStreamDefaultReader<Bytes>,
  total: number,
  existing?: Bytes,
): Promise<Bytes> {
  let buf: Bytes = existing ?? new Uint8Array();
  while (buf.length < total) {
    const { value, done } = await reader.read();
    if (done) throw new Error("header length too short");
    buf = concatBytes(buf, value!);
  }
  return buf;
}

function indexOfSequence(haystack: Bytes, needle: Bytes): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

async function readUntilSequence(
  reader: ReadableStreamDefaultReader<Bytes>,
  needle: Bytes,
): Promise<{ head: Bytes; rest: Bytes }> {
  let buf = new Uint8Array();
  while (true) {
    const idx = indexOfSequence(buf, needle);
    if (idx >= 0) {
      return {
        head: buf.slice(0, idx),
        rest: buf.slice(idx + needle.length),
      };
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("unexpected EOF while reading proxy response");
    buf = concatBytes(buf, value!);
  }
}

function formatHostForAuthority(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parseIpv4Address(hostname: string): Bytes | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^[0-9]+$/.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    out[i] = value;
  }
  return out;
}

function parseIpv6Group(part: string): number[] | null {
  if (!part) return null;
  if (part.includes(".")) {
    const ipv4 = parseIpv4Address(part);
    if (!ipv4) return null;
    return [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
  }
  if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
  return [parseInt(part, 16)];
}

function parseIpv6Address(hostname: string): Bytes | null {
  let value = hostname.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (!value.includes(":")) return null;

  const doubleColonIndex = value.indexOf("::");
  if (doubleColonIndex !== value.lastIndexOf("::")) return null;

  const left = doubleColonIndex >= 0 ? value.slice(0, doubleColonIndex) : value;
  const right = doubleColonIndex >= 0 ? value.slice(doubleColonIndex + 2) : "";
  const leftGroups: number[] = [];
  const rightGroups: number[] = [];

  if (left.length > 0) {
    for (const part of left.split(":")) {
      const parsed = parseIpv6Group(part);
      if (!parsed) return null;
      leftGroups.push(...parsed);
    }
  }

  if (right.length > 0) {
    for (const part of right.split(":")) {
      const parsed = parseIpv6Group(part);
      if (!parsed) return null;
      rightGroups.push(...parsed);
    }
  }

  const totalGroups = leftGroups.length + rightGroups.length;
  let groups: number[];
  if (doubleColonIndex >= 0) {
    if (totalGroups > 8) return null;
    groups = [...leftGroups, ...new Array(8 - totalGroups).fill(0), ...rightGroups];
  } else {
    if (totalGroups !== 8) return null;
    groups = [...leftGroups, ...rightGroups];
  }

  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (groups[i] >> 8) & 0xff;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

function parseAddressBytes(hostname: string): { atyp: number; bytes: Bytes } {
  const ipv4 = parseIpv4Address(hostname);
  if (ipv4) return { atyp: SOCKS5_ATYP_IPV4, bytes: ipv4 };

  const ipv6 = parseIpv6Address(hostname);
  if (ipv6) return { atyp: SOCKS5_ATYP_IPV6, bytes: ipv6 };

  const domain = new TextEncoder().encode(hostname);
  if (domain.length > 255) throw new Error("SOCKS5 hostname is too long");
  return {
    atyp: SOCKS5_ATYP_DOMAIN,
    bytes: concatBytes(new Uint8Array([domain.length]), domain),
  };
}

function parseProxyUrl(raw: string | undefined): ProxyConfig | null {
  const value = raw?.trim() || "";
  if (!value) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
  const url = new URL(hasScheme ? value : `tcp://${value}`);
  const protocol = url.protocol.toLowerCase();
  const host = url.hostname;
  if (!host) throw new Error("PROXY_URL host is empty");

  const username = url.username ? safeDecodeURIComponent(url.username) : "";
  const password = url.password ? safeDecodeURIComponent(url.password) : "";
  const hasAuth = url.username.length > 0 || url.password.length > 0;
  const port = url.port ? Number(url.port) : null;

  if (protocol === "http:" || protocol === "https:") {
    return {
      mode: "http",
      host,
      port: port ?? (protocol === "https:" ? 443 : 80),
      tls: protocol === "https:",
      username: hasAuth ? username : undefined,
      password: hasAuth ? password : undefined,
    };
  }

  if (protocol === "socks5:" || protocol === "socks5h:") {
    return {
      mode: "socks5",
      host,
      port: port ?? 1080,
      tls: false,
      username: hasAuth ? username : undefined,
      password: hasAuth ? password : undefined,
    };
  }

  if (protocol === "tcp:" || protocol === "proxy:" || protocol === "direct:") {
    return {
      mode: "direct",
      host,
      port,
      tls: false,
    };
  }

  throw new Error(`unsupported PROXY_URL scheme: ${protocol}`);
}

function describeProxy(proxy: ProxyConfig, fallbackPort: number): string {
  const authority = `${formatHostForAuthority(proxy.host)}:${proxy.port ?? fallbackPort}`;
  switch (proxy.mode) {
    case "http":
      return `${proxy.tls ? "https" : "http"}://${authority}`;
    case "socks5":
      return `socks5://${authority}`;
    case "direct":
      return `tcp://${authority}`;
  }
}

async function openSocket(hostname: string, port: number): Promise<Socket> {
  const socket = connect({ hostname, port });
  await socket.opened;
  return socket;
}

async function maybeStartTls(socket: Socket, hostname: string): Promise<Socket> {
  const anySocket = socket;
  if (typeof anySocket.startTls !== "function") {
    throw new Error("TLS is not supported by this Workers runtime");
  }
  const tlsSocket = anySocket.startTls({ hostname });
  await tlsSocket.opened;
  return tlsSocket;
}

async function openDirectConnection(hostname: string, port: number): Promise<TunnelConnection> {
  const socket = await openSocket(hostname, port);
  return {
    socket,
    readable: socket.readable,
    writable: socket.writable,
  };
}

function readableFromReader(reader: ReadableStreamDefaultReader<Bytes>, prefix: Bytes = new Uint8Array()): ReadableStream<Bytes> {
  return new ReadableStream<Bytes>({
    start(controller) {
      if (prefix.length > 0) controller.enqueue(prefix);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          try {
            reader.releaseLock();
          } catch {}
          return;
        }
        controller.enqueue(value!);
      } catch (err) {
        controller.error(err);
        try {
          reader.releaseLock();
        } catch {}
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {}
      try {
        reader.releaseLock();
      } catch {}
    },
  });
}

async function writeBytes(writable: WritableStream<Bytes>, data: Bytes): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write(data);
  } finally {
    writer.releaseLock();
  }
}

async function writeUtf8(writable: WritableStream<Bytes>, text: string): Promise<void> {
  await writeBytes(writable, new TextEncoder().encode(text));
}

async function connectHttpProxy(
  targetHost: string,
  targetPort: number,
  proxy: ProxyConfig,
): Promise<TunnelConnection> {
  let socket = await openSocket(proxy.host, proxy.port ?? (proxy.tls ? 443 : 80));
  if (proxy.tls) {
    socket = await maybeStartTls(socket, proxy.host);
  }

  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();

  try {
    const authority = `${formatHostForAuthority(targetHost)}:${targetPort}`;
    let request = `CONNECT ${authority} HTTP/1.1\r\n`;
    request += `Host: ${authority}\r\n`;
    request += `Proxy-Connection: Keep-Alive\r\n`;
    request += `Connection: Keep-Alive\r\n`;
    if (proxy.username !== undefined || proxy.password !== undefined) {
      request += `Proxy-Authorization: Basic ${encodeBase64Utf8(`${proxy.username ?? ""}:${proxy.password ?? ""}`)}\r\n`;
    }
    request += `\r\n`;

    await writer.write(new TextEncoder().encode(request));

    const { head, rest } = await readUntilSequence(reader, new Uint8Array([13, 10, 13, 10]));
    const headerText = new TextDecoder().decode(head);
    const firstLine = headerText.split("\r\n", 1)[0].trim();
    const statusMatch = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
    if (!statusMatch) throw new Error(`invalid HTTP proxy response: ${firstLine || "(empty)"}`);
    const status = Number(statusMatch[1]);
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP proxy CONNECT failed: ${firstLine}`);
    }

    writer.releaseLock();
    return {
      socket,
      readable: readableFromReader(reader, rest),
      writable: socket.writable,
    };
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
    try {
      socket.close();
    } catch {}
    throw err;
  } finally {
    try {
      writer.releaseLock();
    } catch {}
  }
}

async function connectSocks5Proxy(
  targetHost: string,
  targetPort: number,
  proxy: ProxyConfig,
): Promise<TunnelConnection> {
  let socket = await openSocket(proxy.host, proxy.port ?? 1080);
  if (proxy.tls) {
    socket = await maybeStartTls(socket, proxy.host);
  }

  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buffer = new Uint8Array();

  try {
    const hasAuth = proxy.username !== undefined || proxy.password !== undefined;
    const greeting = hasAuth
      ? new Uint8Array([SOCKS5_VERSION, 0x02, 0x00, 0x02])
      : new Uint8Array([SOCKS5_VERSION, 0x01, 0x00]);
    await writer.write(greeting);

    buffer = await readStreamExactly(reader, 2, buffer);
    if (buffer[0] !== SOCKS5_VERSION) throw new Error(`invalid SOCKS5 greeting response: ${buffer[0]}`);
    const method = buffer[1];
    buffer = buffer.slice(2);

    if (method === 0xff) {
      throw new Error("SOCKS5 proxy rejected all authentication methods");
    }

    if (method === 0x02) {
      if (!hasAuth) throw new Error("SOCKS5 proxy requires username/password");
      const user = new TextEncoder().encode(proxy.username ?? "");
      const pass = new TextEncoder().encode(proxy.password ?? "");
      if (user.length > 255 || pass.length > 255) throw new Error("SOCKS5 username/password is too long");
      const authRequest = concatBytes(
        new Uint8Array([0x01, user.length]),
        user,
        new Uint8Array([pass.length]),
        pass,
      );
      await writer.write(authRequest);
      buffer = await readStreamExactly(reader, 2, buffer);
      if (buffer[0] !== 0x01 || buffer[1] !== 0x00) {
        throw new Error(`SOCKS5 auth failed: ${buffer[1]}`);
      }
      buffer = buffer.slice(2);
    } else if (method !== 0x00) {
      throw new Error(`unsupported SOCKS5 auth method: ${method}`);
    }

    const address = parseAddressBytes(targetHost);
    const request = concatBytes(
      new Uint8Array([SOCKS5_VERSION, SOCKS5_CMD_CONNECT, 0x00, address.atyp]),
      address.bytes,
      new Uint8Array([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    );
    await writer.write(request);

    buffer = await readStreamExactly(reader, 4, buffer);
    if (buffer[0] !== SOCKS5_VERSION) throw new Error(`invalid SOCKS5 connect response: ${buffer[0]}`);
    const rep = buffer[1];
    const atyp = buffer[3];

    let total = 4;
    if (atyp === SOCKS5_ATYP_IPV4) {
      total += 4 + 2;
    } else if (atyp === SOCKS5_ATYP_IPV6) {
      total += 16 + 2;
    } else if (atyp === SOCKS5_ATYP_DOMAIN) {
      buffer = await readStreamExactly(reader, 5, buffer);
      total += 1 + buffer[4] + 2;
    } else {
      throw new Error(`invalid SOCKS5 address type: ${atyp}`);
    }

    buffer = await readStreamExactly(reader, total, buffer);
    if (rep !== 0x00) throw new Error(`SOCKS5 connect failed with code ${rep}`);

    const prefix = buffer.slice(total);
    writer.releaseLock();
    return {
      socket,
      readable: readableFromReader(reader, prefix),
      writable: socket.writable,
    };
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
    try {
      socket.close();
    } catch {}
    throw err;
  } finally {
    try {
      writer.releaseLock();
    } catch {}
  }
}

async function connectDirectWithFallback(
  targetHost: string,
  targetPort: number,
  proxy: ProxyConfig,
): Promise<TunnelConnection> {
  let firstError: unknown = null;
  try {
    log({ LOG_LEVEL: "debug" } as Env, `[proxy] direct connect ${targetHost}:${targetPort}`);
    return await openDirectConnection(targetHost, targetPort);
  } catch (err) {
    firstError = err;
  }

  const fallbackPort = proxy.port ?? targetPort;
  if (proxy.host === targetHost && fallbackPort === targetPort) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError ?? "direct connect failed"));
  }

  try {
    log({ LOG_LEVEL: "debug" } as Env, `[proxy] fallback connect ${proxy.host}:${fallbackPort}`);
    return await openDirectConnection(proxy.host, fallbackPort);
  } catch (err) {
    throw err instanceof Error ? err : firstError instanceof Error ? firstError : new Error(String(err));
  }
}

async function connectTunnel(
  targetHost: string,
  targetPort: number,
  proxyRaw: string,
  env?: Env,
): Promise<TunnelConnection> {
  const proxy = parseProxyUrl(proxyRaw);
  if (!proxy) {
    return await openDirectConnection(targetHost, targetPort);
  }

  if (env) {
    log(env, `[proxy] mode=${proxy.mode} target=${targetHost}:${targetPort} via ${describeProxy(proxy, targetPort)}`);
  }

  switch (proxy.mode) {
    case "http":
      return await connectHttpProxy(targetHost, targetPort, proxy);
    case "socks5":
      return await connectSocks5Proxy(targetHost, targetPort, proxy);
    case "direct":
      return await connectDirectWithFallback(targetHost, targetPort, proxy);
  }
}

async function readFirstPacketMeta(
  reader: ReadableStreamDefaultReader<Bytes>,
  cfgUuidStr: string,
): Promise<FirstPktMeta> {
  let header = new Uint8Array();
  header = await readStreamExactly(reader, 1 + 16 + 1, header);

  const version = header[0];
  const uuid = header.slice(1, 1 + 16);
  const cfgUuid = parseUuid(cfgUuidStr);
  if (!validateUuid(uuid, cfgUuid)) throw new Error("invalid credential");

  const pbLen = header[1 + 16];
  const addrPlus1 = 1 + 16 + 1 + pbLen + 1 + 2 + 1;
  header = await readStreamExactly(reader, addrPlus1 + 1, header);

  const cmd = header[1 + 16 + 1 + pbLen];
  if (cmd !== 1) throw new Error(`unsupported command: ${cmd}`);

  const port = (header[addrPlus1 - 1 - 2] << 8) + header[addrPlus1 - 1 - 1];
  const atype = header[addrPlus1 - 1];

  let headerLen = -1;
  if (atype === ADDRESS_TYPE_IPV4) headerLen = addrPlus1 + 4;
  else if (atype === ADDRESS_TYPE_IPV6) headerLen = addrPlus1 + 16;
  else if (atype === ADDRESS_TYPE_STRING) headerLen = addrPlus1 + 1 + header[addrPlus1];
  if (headerLen < 0) throw new Error("read address type failed");

  header = await readStreamExactly(reader, headerLen, header);

  const idx = addrPlus1;
  let hostname = "";
  if (atype === ADDRESS_TYPE_IPV4) {
    hostname = Array.from(header.slice(idx, idx + 4)).map((b) => b.toString()).join(".");
  } else if (atype === ADDRESS_TYPE_STRING) {
    hostname = new TextDecoder().decode(header.slice(idx + 1, idx + 1 + header[idx]));
  } else if (atype === ADDRESS_TYPE_IPV6) {
    hostname = Array.from({ length: 8 }, (_, i) => ((header[idx + i * 2] << 8) + header[idx + i * 2 + 1]).toString(16)).join(":");
  }
  if (!hostname) throw new Error("parse hostname failed");

  return {
    hostname,
    port,
    data: header.slice(headerLen),
    resp: new Uint8Array([version, 0]),
  };
}

async function parseHeader(cfgUuid: string, firstPacket: Bytes): Promise<FirstPktMeta> {
  const readable = new ReadableStream<Bytes>({
    start(controller) {
      controller.enqueue(firstPacket);
      controller.close();
    },
  });
  const reader = readable.getReader();
  try {
    return await readFirstPacketMeta(reader, cfgUuid);
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const settings = getSettings(env);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders() });
    }

    if (path === "/") {
      return withHeaders(new Response("Hello, World\n", { status: 200, headers: { "Content-Type": "text/plain" } }));
    }

    const re = new RegExp(`^/${settings.pathSeg}/([^/]+)(?:/([0-9]+))?$`);
    const m = path.match(re);
    if (!m) return withHeaders(new Response("Not Found", { status: 404 }));

    const sid = m[1];
    const seqStr = m[2] ?? null;

    const id = env.NEST.idFromName(sid);
    const stub = env.NEST.get(id);

    const forwardUrl = new URL(req.url);
    forwardUrl.pathname = seqStr === null ? `/session/${sid}` : `/session/${sid}/${seqStr}`;

    const forwarded = new Request(forwardUrl.toString(), req);
    const resp = await stub.fetch(forwarded);
    return withHeaders(resp);
  },
};

// ---------------- Durable Object ----------------

export class SessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  private nextSeq = 0;
  private initialized = false;
  private downstreamStarted = false;
  private cleaned = false;
  private pendingBuffers: Map<number, Bytes> = new Map();

  private hInfo: FirstPktMeta | null = null;
  private proxyUrlOverride: string | null = null;
  private connection: TunnelConnection | null = null;

  private downstream: WritableStream<Bytes> | null = null;
  private responseHeaderSent = false;
  private aborter: AbortController | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const settings = getSettings(this.env);
    const headers = baseHeaders();

    const m = url.pathname.match(/^\/session\/([^/]+)(?:\/([0-9]+))?$/);
    if (!m) return new Response("Not Found", { status: 404, headers });

    const sid = m[1];
    const seq = m[2] ? parseInt(m[2]) : null;
    const requestProxyUrl = url.searchParams.get("PURL")?.trim() || null;
    if (requestProxyUrl) {
      try {
        parseProxyUrl(requestProxyUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`Bad Request: ${msg}`, { status: 400, headers });
      }

      if (!this.initialized) {
        this.proxyUrlOverride = requestProxyUrl;
        log(this.env, `[DO ${sid}] temporary PURL override set -> ${requestProxyUrl}`);
      } else {
        log(this.env, `[DO ${sid}] temporary PURL received after init; keeping current connection`);
      }
    }

    if (req.method === "GET" && seq === null) {
      log(this.env, `[DO ${sid}] GET downstream open`);
      this.downstreamStarted = true;

      const { readable, writable } = new TransformStream<Bytes, Bytes>();
      this.downstream = writable;

      if (this.initialized && this.hInfo && this.connection) {
        this.startDownstreamPiping();
      }

      return new Response(readable, {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": "image/jpeg",
          "Transfer-Encoding": "chunked",
        },
      });
    }

    if (req.method === "POST" && seq !== null) {
      log(this.env, `[DO ${sid}] POST seq=${seq} len=${req.headers.get("content-length") ?? "?"}`);
      const contentLength = req.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > settings.maxPostSize) {
        return new Response(null, { status: 413, headers });
      }

      const ab = await req.arrayBuffer();
      if (ab.byteLength > settings.maxPostSize) {
        return new Response(null, { status: 413, headers });
      }

      const data = new Uint8Array(ab);
      try {
        await this.processPacket(seq, data, settings);
        return new Response(null, { status: 200, headers });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(this.env, `[DO ${sid}] ERROR handling POST seq=${seq}:`, err);
        this.cleanup();
        return new Response(null, {
          status: 500,
          headers: { ...headers, "X-DO-Error": msg.slice(0, 200) },
        });
      }
    }

    return new Response("Not Found", { status: 404, headers });
  }

  private async initialize(firstPacket: Bytes, settings: Settings): Promise<void> {
    if (this.initialized) return;

    try {
      this.hInfo = await parseHeader(settings.seed, firstPacket);
      const activeProxyUrl = this.proxyUrlOverride || settings.proxyUrl;
      const proxy = activeProxyUrl ? parseProxyUrl(activeProxyUrl) : null;
      if (proxy) {
        log(
          this.env,
          `[DO init] target -> ${this.hInfo.hostname}:${this.hInfo.port} via ${describeProxy(proxy, this.hInfo.port)}`,
        );
      } else {
        log(this.env, `[DO init] target -> ${this.hInfo.hostname}:${this.hInfo.port} direct`);
      }

      this.connection = await connectTunnel(this.hInfo.hostname, this.hInfo.port, activeProxyUrl, this.env);
      this.initialized = true;
    } catch (err) {
      log(this.env, `[DO init] ERROR`, err);
      throw err;
    }

    if (this.hInfo.data.length) {
      await writeBytes(this.connection!.writable, this.hInfo.data);
    }

    if (this.downstream) {
      this.startDownstreamPiping();
    }
  }

  private async processPacket(seq: number, data: Bytes, settings: Settings): Promise<void> {
    if (this.cleaned) throw new Error("session closed");

    this.pendingBuffers.set(seq, data);

    while (this.pendingBuffers.has(this.nextSeq)) {
      const next = this.pendingBuffers.get(this.nextSeq)!;
      this.pendingBuffers.delete(this.nextSeq);

      if (!this.initialized && this.nextSeq === 0) {
        await this.initialize(next, settings);
      } else {
        if (!this.connection) {
          this.nextSeq++;
          continue;
        }
        await writeBytes(this.connection.writable, next);
      }

      this.nextSeq++;
    }

    if (this.pendingBuffers.size > settings.maxBufferedPosts) {
      throw new Error("Too many buffered packets");
    }

    if (!this.downstreamStarted) {
      await this.state.storage.setAlarm(Date.now() + settings.sessionTimeout);
    }
  }

  private startDownstreamPiping(): void {
    if (!this.downstream || !this.hInfo || !this.connection) return;
    if (this.aborter) return;

    log(this.env, `[DO pipe] start downstream piping from ${this.hInfo.hostname}:${this.hInfo.port}`);
    this.aborter = new AbortController();

    const downstream = this.downstream;
    const upstream = this.connection.readable;
    const signal = this.aborter.signal;
    const respHeader = this.hInfo.resp;

    (async () => {
      if (!this.responseHeaderSent) {
        this.responseHeaderSent = true;
        const writer = downstream.getWriter();
        try {
          await writer.write(respHeader);
        } finally {
          writer.releaseLock();
        }
      }

      await upstream.pipeTo(downstream, { signal });
    })()
      .catch((err) => {
        log(this.env, `[DO pipe] ERROR`, err);
      })
      .finally(() => {
        this.cleanup();
      });
  }

  async alarm(): Promise<void> {
    if (!this.downstreamStarted) {
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    log(this.env, `[DO cleanup] closing session`);

    try {
      this.aborter?.abort();
    } catch {}
    this.aborter = null;

    try {
      this.connection?.socket.close();
    } catch {}
    this.connection = null;
    this.downstream = null;
    this.hInfo = null;
    this.proxyUrlOverride = null;
    this.pendingBuffers.clear();
  }
}
