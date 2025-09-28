import { connect } from "cloudflare:sockets";
import { GrpcServiceHandler } from './grpc-handler.js';
import { SecurityManager } from './security-manager.js';
import { ObfuscationManager } from './obfuscation-manager.js';

// Constants
const horse = "dHJvamFu";
const flash = "dm1lc3M=";
const v2 = "djJyYXk=";
const neko = "Y2xhc2g=";
const SUB_PAGE_URL = "https://foolvpn.me/nautica";
const KV_PRX_URL = "https://raw.githubusercontent.com/FoolVPN-ID/Nautica/refs/heads/main/kvProxyList.json";
const PRX_BANK_URL = "https://raw.githubusercontent.com/FoolVPN-ID/Nautica/refs/heads/main/proxyList.txt";
const DNS_SERVER_ADDRESS = "8.8.8.8";
const DNS_SERVER_PORT = 53;
const RELAY_SERVER_UDP = {
  host: "udp-relay.hobihaus.space",
  port: 7300,
};
const PRX_HEALTH_CHECK_API = "https://id1.foolvpn.me/api/v1/check";
const CONVERTER_URL = "https://api.foolvpn.me/convert";

const CORS_HEADER_OPTIONS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// Main worker class
class NauticaGrpcWorker {
  constructor() {
    this.grpcHandler = new GrpcServiceHandler();
    this.securityManager = new SecurityManager();
    this.obfuscationManager = new ObfuscationManager();
  }
  
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    try {
      // Security checks
      if (!this.securityManager.validateRequest(request)) {
        return new Response('Invalid request', { status: 400 });
      }
      
      const clientIP = request.headers.get('cf-connecting-ip') || 
                      request.headers.get('x-real-ip') || 
                      'unknown';
      
      if (!this.securityManager.checkRateLimit(clientIP)) {
        return new Response('Rate limit exceeded', { status: 429 });
      }
      
      // Route handling
      if (url.pathname.startsWith('/nautica.NauticaProxy/')) {
        return await this.grpcHandler.handleRequest(request);
      }
      
      // Original WebSocket handler for backward compatibility
      const upgradeHeader = request.headers.get('upgrade');
      if (upgradeHeader === 'websocket') {
        return await this.handleWebSocket(request, env);
      }
      
      // API endpoints
      if (url.pathname.startsWith('/sub')) {
        return Response.redirect(SUB_PAGE_URL + `?host=${url.hostname}`, 301);
      } else if (url.pathname.startsWith('/check')) {
        return await this.handleHealthCheck(request);
      } else if (url.pathname.startsWith('/api/v1')) {
        return await this.handleApiRequest(request, env);
      }
      
      // Reverse proxy fallback
      const targetReversePrx = env.REVERSE_PRX_TARGET || "example.com";
      return await this.reverseWeb(request, targetReversePrx);
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(`An error occurred: ${error.toString()}`, {
        status: 500,
        headers: CORS_HEADER_OPTIONS,
      });
    }
  }
  
  async handleWebSocket(request, env) {
    const url = new URL(request.url);
    let prxIP = "";
    
    const prxMatch = url.pathname.match(/^\/(.+[:=-]\d+)$/);
    if (url.pathname.length === 3 || url.pathname.match(",")) {
      const prxKeys = url.pathname.replace("/", "").toUpperCase().split(",");
      const prxKey = prxKeys[Math.floor(Math.random() * prxKeys.length)];
      const kvPrx = await this.getKVPrxList();
      prxIP = kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
    } else if (prxMatch) {
      prxIP = prxMatch[1];
    }
    
    return await this.websocketHandler(request, prxIP);
  }
  
  async websocketHandler(request, prxIP) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    
    webSocket.accept();
    
    let addressLog = "";
    let portLog = "";
    const log = (info, event) => {
      console.log(`[${addressLog}:${portLog}] ${info}`, event || "");
    };
    
    const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
    const readableWebSocketStream = this.makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
    
    let remoteSocketWrapper = { value: null };
    let isDNS = false;
    
    readableWebSocketStream
      .pipeTo(
        new WritableStream({
          async write(chunk, controller) {
            if (isDNS) {
              return await this.handleUDPOutbound(
                DNS_SERVER_ADDRESS,
                DNS_SERVER_PORT,
                chunk,
                webSocket,
                null,
                log,
                RELAY_SERVER_UDP
              );
            }
            
            if (remoteSocketWrapper.value) {
              const writer = remoteSocketWrapper.value.writable.getWriter();
              await writer.write(chunk);
              writer.releaseLock();
              return;
            }
            
            const protocol = await this.protocolSniffer(chunk);
            let protocolHeader;
            
            switch (protocol) {
              case 'trojan':
                protocolHeader = this.readHorseHeader(chunk);
                break;
              case 'vmess':
                protocolHeader = this.readFlashHeader(chunk);
                break;
              case 'shadowsocks':
                protocolHeader = this.readSsHeader(chunk);
                break;
              default:
                throw new Error("Unknown Protocol!");
            }
            
            addressLog = protocolHeader.addressRemote;
            portLog = `${protocolHeader.portRemote} -> ${protocolHeader.isUDP ? "UDP" : "TCP"}`;
            
            if (protocolHeader.hasError) {
              throw new Error(protocolHeader.message);
            }
            
            if (protocolHeader.isUDP) {
              if (protocolHeader.portRemote === 53) {
                isDNS = true;
                return await this.handleUDPOutbound(
                  DNS_SERVER_ADDRESS,
                  DNS_SERVER_PORT,
                  chunk,
                  webSocket,
                  protocolHeader.version,
                  log,
                  RELAY_SERVER_UDP
                );
              }
              
              return await this.handleUDPOutbound(
                protocolHeader.addressRemote,
                protocolHeader.portRemote,
                chunk,
                webSocket,
                protocolHeader.version,
                log,
                RELAY_SERVER_UDP
              );
            }
            
            await this.handleTCPOutBound(
              remoteSocketWrapper,
              protocolHeader.addressRemote,
              protocolHeader.portRemote,
              protocolHeader.rawClientData,
              webSocket,
              protocolHeader.version,
              log,
              prxIP
            );
          }.bind(this),
          close() {
            log(`readableWebSocketStream is close`);
          },
          abort(reason) {
            log(`readableWebSocketStream is abort`, JSON.stringify(reason));
          },
        })
      )
      .catch((err) => {
        log("readableWebSocketStream pipeTo error", err);
      });
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
  
  async handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log, prxIP) {
    async function connectAndWrite(address, port) {
      const tcpSocket = connect({
        hostname: address,
        port: port,
      });
      remoteSocket.value = tcpSocket;
      log(`connected to ${address}:${port}`);
      const writer = tcpSocket.writable.getWriter();
      await writer.write(rawClientData);
      writer.releaseLock();
      return tcpSocket;
    }
    
    async function retry() {
      const tcpSocket = await connectAndWrite(
        prxIP.split(/[:=-]/)[0] || addressRemote,
        prxIP.split(/[:=-]/)[1] || portRemote
      );
      tcpSocket.closed
        .catch((error) => {
          console.log("retry tcpSocket closed error", error);
        })
        .finally(() => {
          this.safeCloseWebSocket(webSocket);
        });
      this.remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
    }
    
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    this.remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
  }
  
  async handleUDPOutbound(targetAddress, targetPort, dataChunk, webSocket, responseHeader, log, relay) {
    try {
      let protocolHeader = responseHeader;
      
      const tcpSocket = connect({
        hostname: relay.host,
        port: relay.port,
      });
      
      const header = `udp:${targetAddress}:${targetPort}`;
      const headerBuffer = new TextEncoder().encode(header);
      const separator = new Uint8Array([0x7c]);
      const relayMessage = new Uint8Array(headerBuffer.length + separator.length + dataChunk.byteLength);
      relayMessage.set(headerBuffer, 0);
      relayMessage.set(separator, headerBuffer.length);
      relayMessage.set(new Uint8Array(dataChunk), headerBuffer.length + separator.length);
      
      const writer = tcpSocket.writable.getWriter();
      await writer.write(relayMessage);
      writer.releaseLock();
      
      await tcpSocket.readable.pipeTo(
        new WritableStream({
          async write(chunk) {
            if (webSocket.readyState === 1) { // WS_READY_STATE_OPEN
              if (protocolHeader) {
                webSocket.send(await new Blob([protocolHeader, chunk]).arrayBuffer());
                protocolHeader = null;
              } else {
                webSocket.send(chunk);
              }
            }
          },
          close() {
            log(`UDP connection to ${targetAddress} closed`);
          },
          abort(reason) {
            console.error(`UDP connection aborted due to ${reason}`);
          },
        })
      );
    } catch (e) {
      console.error(`Error while handling UDP outbound: ${e.message}`);
    }
  }
  
  makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
      start(controller) {
        webSocketServer.addEventListener("message", (event) => {
          if (readableStreamCancel) return;
          const message = event.data;
          controller.enqueue(message);
        });
        
        webSocketServer.addEventListener("close", () => {
          this.safeCloseWebSocket(webSocketServer);
          if (readableStreamCancel) return;
          controller.close();
        });
        
        webSocketServer.addEventListener("error", (err) => {
          log("webSocketServer has error");
          controller.error(err);
        });
        
        const { earlyData, error } = this.base64ToArrayBuffer(earlyDataHeader);
        if (error) {
          controller.error(error);
        } else if (earlyData) {
          controller.enqueue(earlyData);
        }
      }.bind(this),
      
      pull(controller) {},
      
      cancel(reason) {
        if (readableStreamCancel) return;
        log(`ReadableStream was canceled, due to ${reason}`);
        readableStreamCancel = true;
        this.safeCloseWebSocket(webSocketServer);
      }
    });
    
    return stream;
  }
  
  async protocolSniffer(buffer) {
    if (buffer.byteLength >= 62) {
      const horseDelimiter = new Uint8Array(buffer.slice(56, 60));
      if (horseDelimiter[0] === 0x0d && horseDelimiter[1] === 0x0a) {
        if (horseDelimiter[2] === 0x01 || horseDelimiter[2] === 0x03 || horseDelimiter[2] === 0x7f) {
          if (horseDelimiter[3] === 0x01 || horseDelimiter[3] === 0x03 || horseDelimiter[3] === 0x04) {
            return atob('dHJvamFu');
          }
        }
      }
    }
    
    const flashDelimiter = new Uint8Array(buffer.slice(1, 17));
    const hex = Array.from(flashDelimiter).map(x => x.toString(16).padStart(2, '0')).join('');
    if (hex.match(/^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/i)) {
      return atob('dm1lc3M=');
    }
    
    return 'shadowsocks';
  }
  
  async remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log) {
    let header = responseHeader;
    let hasIncomingData = false;
    
    await remoteSocket.readable
      .pipeTo(
        new WritableStream({
          start() {},
          async write(chunk, controller) {
            hasIncomingData = true;
            if (webSocket.readyState !== 1) { // WS_READY_STATE_OPEN
              controller.error("webSocket.readyState is not open, maybe close");
            }
            if (header) {
              webSocket.send(await new Blob([header, chunk]).arrayBuffer());
              header = null;
            } else {
              webSocket.send(chunk);
            }
          },
          close() {
            log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
          },
          abort(reason) {
            console.error(`remoteConnection!.readable abort`, reason);
          },
        })
      )
      .catch((error) => {
        console.error(`remoteSocketToWS has exception `, error.stack || error);
        this.safeCloseWebSocket(webSocket);
      });
    
    if (hasIncomingData === false && retry) {
      log(`retry`);
      retry();
    }
  }
  
  safeCloseWebSocket(socket) {
    try {
      if (socket.readyState === 1 || socket.readyState === 2) { // WS_READY_STATE_OPEN or WS_READY_STATE_CLOSING
        socket.close();
      }
    } catch (error) {
      console.error("safeCloseWebSocket error", error);
    }
  }
  
  async getKVPrxList(kvPrxUrl = KV_PRX_URL) {
    try {
      const kvPrx = await fetch(kvPrxUrl);
      if (kvPrx.status === 200) {
        return await kvPrx.json();
      }
      return {};
    } catch (error) {
      console.error('Error fetching KV proxy list:', error);
      return {};
    }
  }
  
  async handleHealthCheck(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('target');
    
    if (!target) {
      return new Response('Missing target parameter', { status: 400 });
    }
    
    const [address, port] = target.split(':');
    const result = await this.checkPrxHealth(address, port || 443);
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...CORS_HEADER_OPTIONS,
        'Content-Type': 'application/json',
      },
    });
  }
  
  async handleApiRequest(request, env) {
    const url = new URL(request.url);
    const apiPath = url.pathname.replace('/api/v1', '');
    
    if (apiPath.startsWith('/sub')) {
      const filterCC = url.searchParams.get('cc')?.split(',') || [];
      const filterPort = url.searchParams.get('port')?.split(',') || [443, 80];
      const filterVPN = url.searchParams.get('vpn')?.split(',') || ['trojan', 'vmess', 'ss'];
      const filterLimit = parseInt(url.searchParams.get('limit')) || 10;
      const filterFormat = url.searchParams.get('format') || 'raw';
      const fillerDomain = url.searchParams.get('domain') || url.hostname;
      
      const prxList = await this.getProxyList(env.PRX_BANK_URL);
      const filteredList = this.filterProxies(prxList, filterCC);
      
      const result = this.generateProxyConfigs(filteredList, fillerDomain, filterLimit, filterPort, filterVPN);
      
      return new Response(result.join('\n'), {
        status: 200,
        headers: CORS_HEADER_OPTIONS,
      });
    }
    
    return new Response('Not found', { status: 404 });
  }
  
  async getProxyList(prxBankUrl = PRX_BANK_URL) {
    try {
      const prxBank = await fetch(prxBankUrl);
      if (prxBank.status === 200) {
        const text = await prxBank.text();
        return text.split('\n')
          .filter(Boolean)
          .map(entry => {
            const [prxIP, prxPort, country, org] = entry.split(',');
            return {
              prxIP: prxIP || 'unknown',
              prxPort: prxPort || '443',
              country: country || 'unknown',
              org: org || 'unknown',
            };
          });
      }
    } catch (error) {
      console.error('Error fetching proxy list:', error);
    }
    return [];
  }
  
  filterProxies(proxies, filterCC) {
    if (filterCC.length === 0) return proxies;
    return proxies.filter(prx => filterCC.includes(prx.country));
  }
  
  generateProxyConfigs(proxies, domain, limit, ports, protocols) {
    const result = [];
    const shuffled = this.shuffleArray([...proxies]);
    
    for (let i = 0; i < Math.min(shuffled.length, limit); i++) {
      const prx = shuffled[i];
      
      for (const port of ports) {
        for (const protocol of protocols) {
          if (result.length >= limit) break;
          
          const uri = new URL(`${protocol}://${domain}`);
          uri.searchParams.set('encryption', 'none');
          uri.searchParams.set('type', 'ws');
          uri.searchParams.set('host', domain);
          
          if (protocol === 'ss') {
            uri.username = btoa(`none:${crypto.randomUUID()}`);
            uri.searchParams.set('plugin', `v2ray-plugin${port == 80 ? '' : ';tls'};mux=0;mode=websocket;path=/${prx.prxIP}-${prx.prxPort};host=${domain}`);
          } else {
            uri.username = crypto.randomUUID();
          }
          
          uri.searchParams.set('security', port == 443 ? 'tls' : 'none');
          uri.searchParams.set('path', `/${prx.prxIP}-${prx.prxPort}`);
          
          uri.hash = `${i + 1} ${this.getFlagEmoji(prx.country)} ${prx.org} WS ${port == 443 ? 'TLS' : 'NTLS'}`;
          result.push(uri.toString());
        }
      }
    }
    
    return result;
  }
  
  async checkPrxHealth(prxIP, prxPort) {
    try {
      const req = await fetch(`${PRX_HEALTH_CHECK_API}?ip=${prxIP}:${prxPort}`);
      return await req.json();
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }
  
  async reverseWeb(request, target) {
    const targetUrl = new URL(request.url);
    const targetChunk = target.split(':');
    
    targetUrl.hostname = targetChunk[0];
    targetUrl.port = targetChunk[1]?.toString() || '443';
    
    const modifiedRequest = new Request(targetUrl, request);
    modifiedRequest.headers.set('X-Forwarded-Host', request.headers.get('Host'));
    
    const response = await fetch(modifiedRequest);
    const newResponse = new Response(response.body, response);
    
    Object.entries(CORS_HEADER_OPTIONS).forEach(([key, value]) => {
      newResponse.headers.set(key, value);
    });
    newResponse.headers.set('X-Proxied-By', 'Cloudflare Worker with gRPC');
    
    return newResponse;
  }
  
  base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    
    try {
      base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
      const decode = atob(base64Str);
      const arrayBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
      return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
      return { error };
    }
  }
  
  readSsHeader(ssBuffer) {
    const view = new DataView(ssBuffer);
    const addressType = view.getUint8(0);
    
    let addressLength = 0;
    let addressValueIndex = 1;
    let addressValue = "";
    
    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = new Uint8Array(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
        break;
      case 3:
        addressLength = new Uint8Array(ssBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 4:
        addressLength = 16;
        const dataView = new DataView(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataView.getUint16(i * 2).toString(16));
        }
        addressValue = ipv6.join(':');
        break;
      default:
        return { hasError: true, message: `Invalid addressType for SS: ${addressType}` };
    }
    
    const portIndex = addressValueIndex + addressLength;
    const portBuffer = ssBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    
    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: portIndex + 2,
      rawClientData: ssBuffer.slice(portIndex + 2),
      version: null,
      isUDP: portRemote == 53,
    };
  }
  
  readFlashHeader(buffer) {
    const version = new Uint8Array(buffer.slice(0, 1));
    let isUDP = false;
    
    const optLength = new Uint8Array(buffer.slice(17, 18))[0];
    const cmd = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
    
    if (cmd === 2) isUDP = true;
    else if (cmd !== 1) {
      return { hasError: true, message: `command ${cmd} is not supported` };
    }
    
    const portIndex = 18 + optLength + 1;
    const portBuffer = buffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = "";
    
    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
        break;
      case 2:
        addressLength = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 1))[0];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 3:
        addressLength = 16;
        const dataView = new DataView(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataView.getUint16(i * 2).toString(16));
        }
        addressValue = ipv6.join(':');
        break;
      default:
        return { hasError: true, message: `invalid addressType is ${addressType}` };
    }
    
    const portIndex2 = addressValueIndex + addressLength;
    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: portIndex2,
      rawClientData: buffer.slice(portIndex2),
      version: new Uint8Array([version[0], 0]),
      isUDP: isUDP,
    };
  }
  
  readHorseHeader(buffer) {
    const dataBuffer = buffer.slice(58);
    if (dataBuffer.byteLength < 6) {
      return { hasError: true, message: "invalid request data" };
    }
    
    let isUDP = false;
    const view = new DataView(dataBuffer);
    const cmd = view.getUint8(0);
    
    if (cmd === 3) isUDP = true;
    else if (cmd !== 1) throw new Error("Unsupported command type!");
    
    const addressType = view.getUint8(1);
    let addressLength = 0;
    let addressValueIndex = 2;
    let addressValue = "";
    
    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = new Uint8Array(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
        break;
      case 3:
        addressLength = new Uint8Array(dataBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 4:
        addressLength = 16;
        const dataView = new DataView(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataView.getUint16(i * 2).toString(16));
        }
        addressValue = ipv6.join(':');
        break;
      default:
        return { hasError: true, message: `invalid addressType is ${addressType}` };
    }
    
    const portIndex = addressValueIndex + addressLength;
    const portBuffer = dataBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    
    return {
      hasError: false,
      addressRemote: addressValue,
      addressType: addressType,
      portRemote: portRemote,
      rawDataIndex: portIndex + 4,
      rawClientData: dataBuffer.slice(portIndex + 4),
      version: null,
      isUDP: isUDP,
    };
  }
  
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  
  getFlagEmoji(isoCode) {
    const codePoints = isoCode
      .toUpperCase()
      .split("")
      .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
  }
}

// Export the worker
const worker = new NauticaGrpcWorker();
export default worker;
