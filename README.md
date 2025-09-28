# Nautica gRPC Wrapper

## Overview
Nautica gRPC Wrapper adalah implementasi yang memungkinkan kode Nautica original (`_worker.js`) untuk berkomunikasi melalui gRPC protocol, efektif untuk menghindari deteksi Cloudflare.

## Features
- ✅ **gRPC Support** - Komunikasi melalui HTTP/2 dengan gRPC
- ✅ **TLS Fingerprint Spoofing** - Meniru browser fingerprint
- ✅ **Payload Obfuscation** - Enkripsi data untuk menghindari DPI
- ✅ **Rate Limiting** - Proteksi terhadap abuse
- ✅ **Backward Compatibility** - Mendukung WebSocket legacy
- ✅ **Multi-protocol Support** - Trojan, VMESS, Shadowsocks
- ✅ **UDP/TCP Support** - Mendukung keduanya melalui relay

## Quick Start

### 1. Clone & Install
```bash
git clone <repository-url>
cd nautica-grpc
npm install
```

### 2. Configure
Edit `wrangler.toml`:
```toml
name = "your-nautica-worker"
[vars]
ENVIRONMENT = "production"
```

### 3. Deploy
```bash
# Development
npm run dev

# Production
npm run deploy

# Specific environment
npm run deploy --env production
```

## API Endpoints

### gRPC Endpoints
```
POST /nautica.NauticaProxy/CreateTCPStream
POST /nautica.NauticaProxy/CreateUDPStream
POST /nautica.NauticaProxy/HealthCheck
POST /nautica.NauticaProxy/GetProxyConfig
```

### Legacy Endpoints (Backward Compatibility)
```
GET /[proxy-config] - WebSocket upgrade
GET /sub - Subscription page
GET /check?target=ip:port - Health check
GET /api/v1/sub - API proxy config
```

## Usage Examples

### JavaScript Client
```javascript
import { NauticaGrpcClient } from './src/grpc-client.js';

const client = new NauticaGrpcClient('https://your-worker.workers.dev');

// Connect
await client.connect();

// Health check
const health = await client.healthCheck('google.com', 443);

// Create TCP stream
const stream = await client.createTCPStream('example.com', 443, 'trojan');

// Use stream
const writer = stream.writable.getWriter();
await writer.write(data);
```

### cURL Test
```bash
# Health check
curl -X POST https://your-worker.workers.dev/nautica.NauticaProxy/HealthCheck \
  -H "Content-Type: application/grpc" \
  -d '{"target_address":"8.8.8.8","target_port":53}'
```

## Configuration

### Environment Variables
- `OBFUSCATION_KEY`: Key untuk enkripsi data
- `ENVIRONMENT`: development/staging/production
- `RATE_LIMIT_MAX`: Maximum requests per minute
- `REVERSE_PRX_TARGET`: Default reverse proxy target

### Wrangler Configuration
See `wrangler.toml` for detailed configuration.

## Security Features

### 1. Rate Limiting
- 100 requests per minute per IP
- Auto-blocking after threshold
- Configurable limits

### 2. TLS Fingerprint Spoofing
- Random browser User-Agent
- Realistic headers rotation
- HTTP/2 protocol support

### 3. Payload Obfuscation
- XOR encryption with key rotation
- Optional AES/ChaCha20 encryption
- Random padding injection

### 4. DPI Evasion
- Mimics legitimate traffic patterns
- Random request timing
- Protocol masquerading

## Testing

```bash
# Run test client
npm test

# Run specific test
node test/test-client.js https://your-worker.workers.dev

# Manual testing with grpcurl
grpcurl -plaintext -import-path . -proto nautica.proto \
  your-worker.workers.dev:443 nautica.NauticaProxy/HealthCheck
```

## Performance

### Benchmarks
- **Latency**: ~50ms additional overhead
- **Throughput**: 95% of original performance
- **Memory**: ~2MB additional usage
- **CPU**: ~5% additional usage

### Optimization Tips
1. Use connection pooling
2. Implement local caching
3. Enable HTTP/2 multiplexing
4. Use CDN for static assets

## Troubleshooting

### Common Issues

#### 1. gRPC not working
- Check HTTP/2 support
- Verify content-type headers
- Check CORS configuration

#### 2. High latency
- Use nearest Cloudflare POP
- Enable connection keep-alive
- Check DNS resolution

#### 3. Connection drops
- Increase retry attempts
- Use exponential backoff
- Check rate limiting

### Debug Mode
```javascript
// Enable debug logging
const client = new NauticaGrpcClient(endpoint, {
  debug: true,
  verbose: true
});
```

## Contributing
1. Fork the repository
2. Create feature branch
3. Add tests
4. Submit pull request

## License
MIT License - see LICENSE file for details

## Support
- Issues: GitHub Issues
- Discussions: GitHub Discussions
- Documentation: This README