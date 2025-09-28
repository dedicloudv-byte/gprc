/**
 * Nautica gRPC Client SDK
 * Provides client-side implementation for gRPC communication
 */
export class NauticaGrpcClient {
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint;
    this.options = {
      timeout: options.timeout || 30000,
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,
      ...options
    };
    this.connectionId = crypto.randomUUID();
    this.isConnected = false;
    this.activeStreams = new Map();
  }
  
  async connect() {
    try {
      // Test connection with health check
      const health = await this.healthCheck('8.8.8.8', 53);
      this.isConnected = health.healthy;
      return this.isConnected;
    } catch (error) {
      console.error('Connection failed:', error);
      this.isConnected = false;
      return false;
    }
  }
  
  async healthCheck(targetAddress, targetPort = 443) {
    const request = {
      target_address: targetAddress,
      target_port: targetPort
    };
    
    const response = await this.makeGrpcRequest('HealthCheck', request);
    return response;
  }
  
  async createTCPStream(targetAddress, targetPort, protocol = 'trojan') {
    const streamId = crypto.randomUUID();
    
    const stream = new NauticaStream({
      endpoint: this.endpoint,
      type: 'TCP',
      targetAddress,
      targetPort,
      protocol,
      streamId,
      connectionId: this.connectionId
    });
    
    this.activeStreams.set(streamId, stream);
    return stream;
  }
  
  async createUDPStream(targetAddress, targetPort) {
    const streamId = crypto.randomUUID();
    
    const stream = new NauticaStream({
      endpoint: this.endpoint,
      type: 'UDP',
      targetAddress,
      targetPort,
      protocol: 'udp',
      streamId,
      connectionId: this.connectionId
    });
    
    this.activeStreams.set(streamId, stream);
    return stream;
  }
  
  async getProxyConfig(options = {}) {
    const request = {
      country_filter: options.country || '',
      limit: options.limit || 10,
      format: options.format || 'raw'
    };
    
    const response = await this.makeGrpcRequest('GetProxyConfig', request);
    return response.configs || [];
  }
  
  async makeGrpcRequest(method, requestData) {
    const url = `${this.endpoint}/nautica.NauticaProxy/${method}`;
    
    const body = this.encodeGrpcFrame(requestData);
    
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc',
        'TE': 'trailers',
        'X-Connection-ID': this.connectionId,
        'User-Agent': this.getRandomUserAgent()
      },
      body
    });
    
    if (!response.ok) {
      throw new Error(`gRPC request failed: ${response.status} ${response.statusText}`);
    }
    
    const responseData = await response.arrayBuffer();
    return this.decodeGrpcFrame(responseData);
  }
  
  async fetchWithRetry(url, options, attempt = 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(this.options.timeout)
      });
      
      if (response.status >= 500 && attempt < this.options.retryAttempts) {
        await this.delay(this.options.retryDelay * attempt);
        return this.fetchWithRetry(url, options, attempt + 1);
      }
      
      return response;
    } catch (error) {
      if (attempt < this.options.retryAttempts) {
        await this.delay(this.options.retryDelay * attempt);
        return this.fetchWithRetry(url, options, attempt + 1);
      }
      throw error;
    }
  }
  
  encodeGrpcFrame(data) {
    const jsonString = JSON.stringify(data);
    const buffer = new TextEncoder().encode(jsonString);
    
    // gRPC frame format: 1 byte compression flag + 4 bytes length + data
    const frame = new Uint8Array(5 + buffer.length);
    frame[0] = 0; // No compression
    new DataView(frame.buffer).setUint32(1, buffer.length, false);
    frame.set(buffer, 5);
    
    return frame;
  }
  
  decodeGrpcFrame(buffer) {
    if (buffer.byteLength < 5) {
      throw new Error('Invalid gRPC frame');
    }
    
    const view = new DataView(buffer);
    const compressed = view.getUint8(0) !== 0;
    const length = view.getUint32(1, false);
    
    if (buffer.byteLength < 5 + length) {
      throw new Error('Incomplete gRPC frame');
    }
    
    const data = buffer.slice(5, 5 + length);
    const jsonString = new TextDecoder().decode(data);
    
    return JSON.parse(jsonString);
  }
  
  getRandomUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];
    
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  close() {
    // Close all active streams
    this.activeStreams.forEach(stream => stream.close());
    this.activeStreams.clear();
    this.isConnected = false;
  }
}

/**
 * Nautica Stream class for handling bidirectional data
 */
class NauticaStream {
  constructor(options) {
    this.options = options;
    this.streamId = options.streamId;
    this.isOpen = false;
    this.reader = null;
    this.writer = null;
    
    this.readable = new ReadableStream({
      start: (controller) => {
        this.reader = controller;
      }
    });
    
    this.writable = new WritableStream({
      write: (chunk) => this.write(chunk),
      close: () => this.close()
    });
  }
  
  async write(data) {
    if (!this.isOpen) {
      await this.open();
    }
    
    const request = {
      data: Array.from(new Uint8Array(data)),
      target_address: this.options.targetAddress,
      target_port: this.options.targetPort,
      protocol: this.options.protocol,
      connection_id: this.options.connectionId
    };
    
    const frame = this.encodeFrame(request);
    
    try {
      const response = await fetch(`${this.options.endpoint}/nautica.NauticaProxy/Create${this.options.type}Stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/grpc',
          'TE': 'trailers',
          'X-Stream-ID': this.streamId
        },
        body: frame,
        duplex: 'half'
      });
      
      if (!response.ok) {
        throw new Error(`Stream write failed: ${response.status}`);
      }
      
      // Handle response
      const reader = response.body.getReader();
      this.processResponse(reader);
      
    } catch (error) {
      console.error('Stream write error:', error);
      throw error;
    }
  }
  
  async open() {
    this.isOpen = true;
    // Additional initialization if needed
  }
  
  async close() {
    this.isOpen = false;
    if (this.reader) {
      this.reader.close();
    }
  }
  
  encodeFrame(data) {
    const jsonString = JSON.stringify(data);
    const buffer = new TextEncoder().encode(jsonString);
    
    const frame = new Uint8Array(5 + buffer.length);
    frame[0] = 0; // No compression
    new DataView(frame.buffer).setUint32(1, buffer.length, false);
    frame.set(buffer, 5);
    
    return frame;
  }
  
  async processResponse(reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const frame = this.decodeFrame(value);
        if (frame && this.reader) {
          this.reader.enqueue(new Uint8Array(frame.data));
        }
      }
    } catch (error) {
      console.error('Stream processing error:', error);
    }
  }
  
  decodeFrame(buffer) {
    if (buffer.byteLength < 5) return null;
    
    const view = new DataView(buffer);
    const length = view.getUint32(1, false);
    
    if (buffer.byteLength < 5 + length) return null;
    
    const data = buffer.slice(5, 5 + length);
    const jsonString = new TextDecoder().decode(data);
    
    try {
      return JSON.parse(jsonString);
    } catch {
      return null;
    }
  }
}

// Usage example
export async function exampleUsage() {
  const client = new NauticaGrpcClient('https://your-worker.workers.dev');
  
  // Connect
  const connected = await client.connect();
  if (!connected) {
    console.error('Failed to connect');
    return;
  }
  
  // Health check
  const health = await client.healthCheck('google.com', 443);
  console.log('Health:', health);
  
  // Get proxy config
  const configs = await client.getProxyConfig({ limit: 5, country: 'US' });
  console.log('Configs:', configs);
  
  // Create TCP stream
  const stream = await client.createTCPStream('example.com', 443, 'trojan');
  
  // Use the stream
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode('Hello World'));
  writer.releaseLock();
  
  const reader = stream.readable.getReader();
  const { value } = await reader.read();
  console.log('Received:', new TextDecoder().decode(value));
  
  // Cleanup
  client.close();
}

export { NauticaGrpcClient, NauticaStream };