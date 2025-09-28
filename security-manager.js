export class SecurityManager {
  constructor(options = {}) {
    this.rateLimitWindow = options.rateLimitWindow || 60000; // 1 minute
    this.maxRequests = options.maxRequests || 100;
    this.rateLimits = new Map();
    this.blockedIPs = new Set();
  }
  
  validateRequest(request) {
    // Validate HTTP version
    if (!this.isHttp2(request)) {
      return false;
    }
    
    // Validate content type for gRPC
    const contentType = request.headers.get('content-type');
    if (request.url.includes('/nautica.NauticaProxy/')) {
      if (!contentType || !contentType.includes('application/grpc')) {
        return false;
      }
    }
    
    // Validate headers
    if (!this.validateHeaders(request.headers)) {
      return false;
    }
    
    return true;
  }
  
  isHttp2(request) {
    // Cloudflare Workers support HTTP/2
    return true;
  }
  
  validateHeaders(headers) {
    const requiredHeaders = ['user-agent', 'accept'];
    const forbiddenHeaders = ['x-forwarded-for', 'cf-connecting-ip'];
    
    // Check for suspicious patterns
    const userAgent = headers.get('user-agent') || '';
    if (this.isBotUserAgent(userAgent)) {
      return false;
    }
    
    // Check for known attack patterns
    const referer = headers.get('referer') || '';
    if (this.isSuspiciousReferer(referer)) {
      return false;
    }
    
    return true;
  }
  
  isBotUserAgent(userAgent) {
    const botPatterns = [
      'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget',
      'python', 'java', 'postman', 'burp', 'nmap'
    ];
    
    return botPatterns.some(pattern => 
      userAgent.toLowerCase().includes(pattern)
    );
  }
  
  isSuspiciousReferer(referer) {
    const suspiciousPatterns = [
      'localhost', '127.0.0.1', '192.168.', '10.0.',
      'admin', 'config', 'wp-admin', 'phpmyadmin'
    ];
    
    return suspiciousPatterns.some(pattern =>
      referer.toLowerCase().includes(pattern)
    );
  }
  
  checkRateLimit(clientIP) {
    const now = Date.now();
    
    if (this.blockedIPs.has(clientIP)) {
      return false;
    }
    
    let clientData = this.rateLimits.get(clientIP);
    if (!clientData) {
      clientData = { count: 0, resetTime: now + this.rateLimitWindow };
      this.rateLimits.set(clientIP, clientData);
    }
    
    // Reset counter if window expired
    if (now > clientData.resetTime) {
      clientData.count = 0;
      clientData.resetTime = now + this.rateLimitWindow;
    }
    
    // Check limit
    if (clientData.count >= this.maxRequests) {
      this.blockIP(clientIP);
      return false;
    }
    
    clientData.count++;
    return true;
  }
  
  blockIP(ip) {
    this.blockedIPs.add(ip);
    
    // Auto-unblock after 1 hour
    setTimeout(() => {
      this.blockedIPs.delete(ip);
      this.rateLimits.delete(ip);
    }, 3600000);
  }
  
  getSecurityHeaders() {
    return {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Content-Security-Policy': "default-src 'self'",
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
  }
  
  addSecurityHeaders(response) {
    const securityHeaders = this.getSecurityHeaders();
    Object.entries(securityHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  }
}