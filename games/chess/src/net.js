// Reconnecting WebSocket client for online games.
export class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onOpen = null;
    this.retry = 0;
    this.closed = false;
    const base = location.pathname.replace(/[^/]*$/, '');
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}ws`;
  }

  connect() {
    this.closed = false;
    this.ws = new WebSocket(this.url);
    this.onStatus('connecting');
    this.ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      this.onOpen?.();
      clearInterval(this.pinger);
      this.pinger = setInterval(() => this.send({ t: 'ping' }), 25000);
    };
    this.ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    this.ws.onclose = () => {
      clearInterval(this.pinger);
      if (this.closed) return;
      this.onStatus('closed');
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  get isOpen() {
    return this.ws?.readyState === 1;
  }

  send(obj) {
    if (this.isOpen) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.pinger);
    this.ws?.close();
  }
}
