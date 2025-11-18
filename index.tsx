import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// --- Logger Utility (Modified for React Subscription) ---

const Logger = {
  listeners: new Set<(log: string) => void>(),
  logs: [] as string[],

  output(...messages: any[]) {
    const timestamp = this._getTimestamp();
    const text = messages.map(m => 
      (typeof m === 'object' ? JSON.stringify(m) : String(m))
    ).join(' ');
    const logEntry = `[${timestamp}] ${text}`;
    
    this.logs.push(logEntry);
    if (this.logs.length > 1000) this.logs.shift(); // Prevent memory overflow

    this.listeners.forEach(l => l(logEntry));
    console.log(logEntry);
  },

  subscribe(listener: (log: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  },

  getHistory() {
    return [...this.logs];
  },
  
  _getTimestamp() {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    return `${time}.${ms}`;
  }
};

// --- Logic Classes ---

class ConnectionManager extends EventTarget {
  endpoint: string;
  socket: WebSocket | null;
  isConnected: boolean;
  reconnectDelay: number;
  maxReconnectAttempts: number;
  reconnectAttempts: number;
  shouldReconnect: boolean;

  constructor(endpoint = 'ws://127.0.0.1:9998') {
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.maxReconnectAttempts = Infinity;
    this.reconnectAttempts = 0;
    this.shouldReconnect = true;
  }
  
  async establish() {
    if (this.isConnected) {
      Logger.output('[ConnectionManager] 连接已存在');
      return Promise.resolve();
    }
    
    this.shouldReconnect = true;
    Logger.output('[ConnectionManager] 建立连接:', this.endpoint);
    
    return new Promise<void>((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.endpoint);
      } catch (e) {
        Logger.output('[ConnectionManager] WebSocket 创建失败:', e);
        reject(e);
        return;
      }
      
      this.socket.addEventListener('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        Logger.output('[ConnectionManager] 连接建立成功');
        this.dispatchEvent(new CustomEvent('connected'));
        resolve();
      });
      
      this.socket.addEventListener('close', (event) => {
        this.isConnected = false;
        Logger.output(`[ConnectionManager] 连接断开 (Code: ${event.code})`);
        this.dispatchEvent(new CustomEvent('disconnected'));
        if (this.shouldReconnect) {
            this._scheduleReconnect();
        }
      });
      
      this.socket.addEventListener('error', (error) => {
        Logger.output('[ConnectionManager] 连接错误');
        this.dispatchEvent(new CustomEvent('error', { detail: error }));
      });
    });
  }

  disconnect() {
      this.shouldReconnect = false;
      if (this.socket) {
          this.socket.close();
          this.socket = null;
      }
      this.isConnected = false;
  }
  
  transmit(data: any) {
    if (!this.isConnected || !this.socket) {
      Logger.output('[ConnectionManager] 无法发送数据：连接未建立');
      return false;
    }
    
    this.socket.send(JSON.stringify(data));
    return true;
  }
  
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.output('[ConnectionManager] 达到最大重连次数');
      return;
    }
    
    this.reconnectAttempts++;
    setTimeout(() => {
      if (this.shouldReconnect) {
        Logger.output(`[ConnectionManager] 重连尝试 ${this.reconnectAttempts}`);
        this.establish().catch(() => {});
      }
    }, this.reconnectDelay);
  }
}

class RequestProcessor {
  activeOperations: Map<string, AbortController>;
  targetDomain: string;

  constructor() {
    this.activeOperations = new Map();
    this.targetDomain = 'generativelanguage.googleapis.com';
  }
  
  async execute(requestSpec: any, operationId: string) {
    Logger.output('[RequestProcessor] 执行请求:', requestSpec.method, requestSpec.path);
    
    try {
      const abortController = new AbortController();
      this.activeOperations.set(operationId, abortController);
      
      const requestUrl = this._constructUrl(requestSpec);
      Logger.output(`[RequestProcessor] 构造的最终请求URL: ${requestUrl}`);
      const requestConfig = this._buildRequestConfig(requestSpec, abortController.signal);
      
      const response = await fetch(requestUrl, requestConfig);
      
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}. Body: ${errorBody}`);
      }
      
      return response;
    } catch (error: any) {
      Logger.output('[RequestProcessor] 请求执行失败:', error.message);
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }
  
  cancelOperation(operationId: string) {
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      controller.abort();
      this.activeOperations.delete(operationId);
      Logger.output('[RequestProcessor] 操作已取消:', operationId);
    }
  }
  
  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => {
      controller.abort();
      Logger.output('[RequestProcessor] 取消操作:', id);
    });
    this.activeOperations.clear();
  }
  
  // =================================================================
  // ===                 ***   核心修改区域   ***                 ===
  // =================================================================
  _constructUrl(requestSpec: any) {
    let pathSegment = requestSpec.path.startsWith('/') ? 
      requestSpec.path.substring(1) : requestSpec.path;
    
    const queryParams = new URLSearchParams(requestSpec.query_params);

    // 核心修改逻辑：仅在假流式模式下，将请求路径和参数修改为非流式
    if (requestSpec.streaming_mode === 'fake') {
      Logger.output('[RequestProcessor] 假流式模式激活，正在尝试将请求修改为非流式。');
      
      // 检查并修改 Gemini API 的路径
      if (pathSegment.includes(':streamGenerateContent')) {
        pathSegment = pathSegment.replace(':streamGenerateContent', ':generateContent');
        Logger.output(`[RequestProcessor] API路径已修改为: ${pathSegment}`);
      }
      
      // 检查并移除流式请求特有的查询参数 "alt=sse"
      if (queryParams.has('alt') && queryParams.get('alt') === 'sse') {
        queryParams.delete('alt');
        Logger.output('[RequestProcessor] 已移除 "alt=sse" 查询参数。');
      }
    }
    
    const queryString = queryParams.toString();
    
    return `https://${this.targetDomain}/${pathSegment}${queryString ? '?' + queryString : ''}`;
  }
  // =================================================================
  // ===                 ***   修改区域结束   ***                 ===
  // =================================================================
  
  _generateRandomString(length: number) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  _buildRequestConfig(requestSpec: any, signal: AbortSignal) {
    const config: RequestInit = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal
    };
    
    if (['POST', 'PUT', 'PATCH'].includes(requestSpec.method) && requestSpec.body) {
      try {
        const bodyObj = JSON.parse(requestSpec.body);
        
        if (bodyObj.contents && Array.isArray(bodyObj.contents) && bodyObj.contents.length > 0) {
          const lastContent = bodyObj.contents[bodyObj.contents.length - 1];
          if (lastContent.parts && Array.isArray(lastContent.parts) && lastContent.parts.length > 0) {
            const lastPart = lastContent.parts[lastContent.parts.length - 1];
            if (lastPart.text && typeof lastPart.text === 'string') {
              const decoyString = this._generateRandomString(5);
              lastPart.text += `\n\n[sig:${decoyString}]`; 
              Logger.output('[RequestProcessor] 已成功向提示文本末尾添加伪装字符串。');
            }
          }
        }
        
        config.body = JSON.stringify(bodyObj);

      } catch (e) {
        Logger.output('[RequestProcessor] 请求体不是JSON，按原样发送。');
        config.body = requestSpec.body;
      }
    }
    
    return config;
  }
  
  _sanitizeHeaders(headers: any) {
    const sanitized = { ...headers };
    const forbiddenHeaders = [
      'host', 'connection', 'content-length', 'origin',
      'referer', 'user-agent', 'sec-fetch-mode',
      'sec-fetch-site', 'sec-fetch-dest'
    ];
    
    forbiddenHeaders.forEach(header => delete sanitized[header]);
    return sanitized;
  }
}

class ProxySystem extends EventTarget {
  connectionManager: ConnectionManager;
  requestProcessor: RequestProcessor;

  constructor(websocketEndpoint: string) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this._setupEventHandlers();
  }
  
  async start() {
    Logger.output('[ProxySystem] 系统启动中...');
    try {
      await this.connectionManager.establish();
      Logger.output('[ProxySystem] 系统启动成功');
      this.dispatchEvent(new CustomEvent('ready'));
    } catch (error: any) {
      Logger.output('[ProxySystem] 系统启动失败:', error.message);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }

  stop() {
      this.connectionManager.disconnect();
      this.requestProcessor.cancelAllOperations();
      Logger.output('[ProxySystem] 系统已停止');
  }
  
  _setupEventHandlers() {
    this.connectionManager.addEventListener('message', (event: any) => {
      this._handleIncomingMessage(event.detail);
    });
    
    this.connectionManager.addEventListener('disconnected', () => {
      this.requestProcessor.cancelAllOperations();
    });
  }
  
  async _handleIncomingMessage(messageData: string) {
    let requestSpec: any = {};
    try {
      requestSpec = JSON.parse(messageData);
      Logger.output('[ProxySystem] 收到请求:', requestSpec.method, requestSpec.path);
      Logger.output(`[ProxySystem] 服务器模式为: ${requestSpec.streaming_mode || 'fake'}`);
      
      await this._processProxyRequest(requestSpec);
    } catch (error: any) {
      Logger.output('[ProxySystem] 消息处理错误:', error.message);
      const operationId = requestSpec.request_id;
      this._sendErrorResponse(error, operationId);
    }
  }
  
  async _processProxyRequest(requestSpec: any) {
    const operationId = requestSpec.request_id;
    const mode = requestSpec.streaming_mode || 'fake';

    try {
      const response = await this.requestProcessor.execute(requestSpec, operationId);
      this._transmitHeaders(response, operationId);

      if (mode === 'real') {
        Logger.output('[ProxySystem] 以真流式模式处理响应 (逐块读取)...');
        const reader = response.body?.getReader();
        const textDecoder = new TextDecoder();
        
        if (reader) {
            while (true) {
            const { done, value } = await reader.read();
            if (done) {
                Logger.output('[ProxySystem] 真流式读取完成。');
                break;
            }
            const textChunk = textDecoder.decode(value, { stream: true });
            this._transmitChunk(textChunk, operationId);
            }
        }
      } else {
        // 在假流式模式下，我们期望的是一个非流式响应，所以一次性读取是正确的
        Logger.output('[ProxySystem] 以假流式模式处理响应 (一次性读取)...');
        const fullBody = await response.text();
        Logger.output('[ProxySystem] 已获取完整响应体，长度:', fullBody.length);
        this._transmitChunk(fullBody, operationId);
      }

      this._transmitStreamEnd(operationId);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        Logger.output('[ProxySystem] 请求被中止');
      } else {
        this._sendErrorResponse(error, operationId);
      }
    }
  }
  
  _transmitHeaders(response: Response, operationId: string) {
    const headerMap: any = {};
    response.headers.forEach((value, key) => {
      headerMap[key] = value;
    });
    
    const headerMessage = {
      request_id: operationId,
      event_type: 'response_headers',
      status: response.status,
      headers: headerMap
    };
    
    this.connectionManager.transmit(headerMessage);
    Logger.output('[ProxySystem] 响应头已传输');
  }

  _transmitChunk(chunk: string, operationId: string) {
    if (!chunk) return;
    const chunkMessage = {
      request_id: operationId,
      event_type: 'chunk',
      data: chunk
    };
    this.connectionManager.transmit(chunkMessage);
  }

  _transmitStreamEnd(operationId: string) {
    const endMessage = {
      request_id: operationId,
      event_type: 'stream_close'
    };
    this.connectionManager.transmit(endMessage);
    Logger.output('[ProxySystem] 流结束信号已传输');
  }
  
  _sendErrorResponse(error: any, operationId: string) {
    if (!operationId) {
      Logger.output('[ProxySystem] 无法发送错误响应：缺少操作ID');
      return;
    }
    
    const errorMessage = {
      request_id: operationId,
      event_type: 'error',
      status: 500,
      message: `代理系统错误: ${error.message || '未知错误'}`
    };
    
    this.connectionManager.transmit(errorMessage);
    Logger.output('[ProxySystem] 错误响应已发送');
  }
}

// --- React Application ---

const App = () => {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [wsUrl, setWsUrl] = useState('ws://127.0.0.1:9998');
  const logsEndRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<ProxySystem | null>(null);

  // Subscribe to Logger updates
  useEffect(() => {
    // Load initial logs
    setLogs(Logger.getHistory());
    
    const unsubscribe = Logger.subscribe((newLog) => {
      setLogs(prev => [...prev, newLog]);
    });
    return unsubscribe;
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleConnect = async () => {
    if (proxyRef.current) {
        proxyRef.current.stop();
    }

    setStatus('connecting');
    const system = new ProxySystem(wsUrl);
    proxyRef.current = system;

    // Listen to connection events from the ConnectionManager
    system.connectionManager.addEventListener('connected', () => setStatus('connected'));
    system.connectionManager.addEventListener('disconnected', () => setStatus('disconnected'));
    system.connectionManager.addEventListener('error', () => setStatus('disconnected'));

    try {
        await system.start();
    } catch (e) {
        setStatus('disconnected');
    }
  };

  const handleDisconnect = () => {
      if (proxyRef.current) {
          proxyRef.current.stop();
          proxyRef.current = null;
          setStatus('disconnected');
      }
  };

  useEffect(() => {
      // Initial connection attempt on mount (optional, but good for "just working")
      handleConnect();
      return () => {
          if (proxyRef.current) proxyRef.current.stop();
      }
  }, []);

  return (
    <>
      <header className="header">
        <div className="title">
          <span>Gemini Proxy Terminal</span>
          <div className={`status-badge`}>
            <div className={`dot ${status}`}></div>
            <span style={{textTransform: 'capitalize', color: '#aaa'}}>{status}</span>
          </div>
        </div>
        
        <div className="control-group">
          <input 
            type="text" 
            className="url-input"
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            disabled={status === 'connected'}
            placeholder="WebSocket Endpoint"
          />
          {status === 'connected' || status === 'connecting' ? (
             <button className="btn-disconnect" onClick={handleDisconnect}>Disconnect</button>
          ) : (
             <button className="btn-connect" onClick={handleConnect}>Connect</button>
          )}
        </div>
      </header>

      <main className="logs-container">
        {logs.map((log, index) => {
            // Parse timestamp and message for prettier display
            const match = log.match(/^\[(.*?)\] (.*)/);
            const time = match ? match[1] : '';
            const msg = match ? match[2] : log;
            
            return (
                <div key={index} className="log-entry">
                    {time && <span className="log-time">[{time}]</span>}
                    <span className="log-msg">{msg}</span>
                </div>
            );
        })}
        <div ref={logsEndRef} />
      </main>
    </>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
