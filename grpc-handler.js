import { connect } from "cloudflare:sockets";

// Constants
const GRPC_CONTENT_TYPE = 'application/grpc';
const GRPC_STATUS_OK = '0';
const GRPC_STATUS_ERROR = '2';

// gRPC Frame format utilities
class GrpcFrame {
  static encode(data, compress = false) {
    const buffer = new Uint8Array(data);
    const frame = new Uint8Array(5 + buffer.length);
    
    // Compression flag (1 byte)
    frame[0] = compress ? 1 : 0;
    
    // Message length (4 bytes, big-endian)
    const view = new DataView(frame.buffer);
    view.setUint32(1, buffer.length, false);
    
    // Message data
    frame.set(buffer, 5);
    
    return frame;
  }
  
  static decode(frame) {
    if (frame.length < 5) return null;
    
    const view = new DataView(frame.buffer);
    const compressed = view.getUint8(0) === 1;
    const length = view.getUint32(1, false);
    
    if (frame.length < 5 + length) return null;
    
    return {
      compressed,
      data: frame.slice(5, 5 + length)
    };
  }
}

// Protocol sniffer (dari kode original)
class ProtocolSniffer {
  static async detect(buffer) {
    if (buffer.byteLength >= 62) {
      const horseDelimiter = new Uint8Array(buffer.slice(56, 60));
      if (horseDelimiter[0] === 0x0d && horseDelimiter[1] === 0x0a) {
        if (horseDelimiter[2] === 0x01 || horseDelimiter[2] === 0x03 || horseDelimiter[2] === 0x7f) {
          if (horseDelimiter[3] === 0x01 || horseDelimiter[3] === 0x03 || horseDelimiter[3] === 0x04) {
            return 'trojan';
          }
        }
      }
    }
    
    const flashDelimiter = new Uint8Array(buffer.slice(1, 17));
    const hex = Array.from(flashDelimiter).map(x => x.toString(16).padStart(2, '0')).join('');
    if (hex.match(/^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/i)) {
      return 'vmess';
    }
    
    return 'shadowsocks';
  }
}

// gRPC Service Handler
export class GrpcServiceHandler {
  constructor(env) {
    this.env = env;
    this.connections = new Map();
  }
  
  async handleRequest(request) {
    const url = new URL(request.url);
    const method = url.pathname.split('/').pop();
    
    try {
      switch (method) {
        case 'CreateTCPStream':
          return await this.handleTCPStream(request);
        case 'CreateUDPStream':
          return await this.handleUDPStream(request);
        case 'HealthCheck':
          return await this.handleHealthCheck(request);
        case 'GetProxyConfig':
          return await this.handleProxyConfig(request);
        default:
          return this.createGrpcError('Method not found', 12);
      }
    } catch (error) {
      console.error('gRPC handler error:', error);
      return this.createGrpcError(error.message, 2);
    }
  }
  
  async handleTCPStream(request) {
    const connectionId = crypto.randomUUID();
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    server.accept();
    
    // Handle bidirectional streaming
    const readable = new ReadableStream({
      start: async (controller) => {
        server.addEventListener('message', (event) => {
          const frame = GrpcFrame.encode(event.data);
          controller.enqueue(frame);
        });
        
        server.addEventListener('close', () => {
          controller.close();
          this.connections.delete(connectionId);
        });
        
        server.addEventListener('error', (error) => {
          controller.error(error);
          this.connections.delete(connectionId);
        });
      }
    });
    
    const writable = new WritableStream({
      write: async (chunk) => {
        const frame = GrpcFrame.decode(chunk);
        if (frame) {
          const proxyData = JSON.parse(new TextDecoder().decode(frame.data));
          
          // Forward data through WebSocket
          if (proxyData.data) {
            server.send(new Uint8Array(proxyData.data));
          }
        }
      }
    });
    
    // Process request body
    request.body.pipeTo(writable);
    
    this.connections.set(connectionId, {
      socket: server,
      type: 'tcp'
    });
    
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': GRPC_CONTENT_TYPE,
        'grpc-status': GRPC_STATUS_OK
      }
    });
  }
  
  async handleUDPStream(request) {
    // Similar to TCP but with UDP handling
    const connectionId = crypto.randomUUID();
    
    return this.handleTCPStream(request); // For now, same as TCP
  }
  
  async handleHealthCheck(request) {
    const body = await request.arrayBuffer();
    const frame = GrpcFrame.decode(new Uint8Array(body));
    
    if (!frame) {
      return this.createGrpcError('Invalid request', 3);
    }
    
    const healthRequest = JSON.parse(new TextDecoder().decode(frame.data));
    
    // Perform health check
    const start = Date.now();
    try {
      const socket = connect({
        hostname: healthRequest.target_address,
        port: healthRequest.target_port || 443
      });
      
      socket.close();
      const latency = Date.now() - start;
      
      const response = {
        healthy: true,
        latency_ms: latency,
        message: 'Connection successful'
      };
      
      return this.createGrpcResponse(response);
    } catch (error) {
      const response = {
        healthy: false,
        latency_ms: 0,
        message: error.message
      };
      
      return this.createGrpcResponse(response);
    }
  }
  
  async handleProxyConfig(request) {
    // Implement proxy config retrieval
    const proxyList = await this.getProxyList();
    
    const response = {
      configs: proxyList.slice(0, 10) // Limit to 10 for now
    };
    
    return this.createGrpcResponse(response);
  }
  
  async getProxyList() {
    // Fetch from external source or use cache
    try {
      const response = await fetch('https://raw.githubusercontent.com/FoolVPN-ID/Nautica/refs/heads/main/proxyList.txt');
      const text = await response.text();
      
      return text.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [address, port, country, org] = line.split(',');
          return {
            address: address || 'unknown',
            port: parseInt(port) || 443,
            country: country || 'unknown',
            organization: org || 'unknown',
            protocol: 'trojan'
          };
        });
    } catch (error) {
      console.error('Error fetching proxy list:', error);
      return [];
    }
  }
  
  createGrpcResponse(data) {
    const encoded = GrpcFrame.encode(new TextEncoder().encode(JSON.stringify(data)));
    return new Response(encoded, {
      status: 200,
      headers: {
        'Content-Type': GRPC_CONTENT_TYPE,
        'grpc-status': GRPC_STATUS_OK
      }
    });
  }
  
  createGrpcError(message, code) {
    return new Response(message, {
      status: 200,
      headers: {
        'Content-Type': GRPC_CONTENT_TYPE,
        'grpc-status': code.toString(),
        'grpc-message': message
      }
    });
  }
}

export default GrpcServiceHandler;