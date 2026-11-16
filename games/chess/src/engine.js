// Thin UCI wrapper around the Stockfish WASM worker. Searches run one at a time.
export class Engine {
  constructor(url) {
    this.failed = false;
    this.resolve = null;
    this.queue = Promise.resolve();
    try {
      this.w = new Worker(url);
    } catch (e) {
      this.failed = true;
      this.ready = Promise.reject(e);
      this.ready.catch(() => {});
      return;
    }
    this.ready = new Promise((res, rej) => {
      this.onReady = res;
      this.w.onerror = (e) => {
        this.failed = true;
        rej(e);
        if (this.resolve) this.finish(null);
      };
      setTimeout(() => rej(new Error('engine load timeout')), 20000);
    });
    this.ready.catch(() => (this.failed = true));
    this.w.onmessage = (e) => this.onLine(String(e.data));
    this.post('uci');
  }

  post(cmd) {
    this.w?.postMessage(cmd);
  }

  onLine(line) {
    if (line === 'uciok') this.post('isready');
    else if (line === 'readyok' && this.onReady) {
      this.onReady();
      this.onReady = null;
    } else if (line.startsWith('info') && line.includes(' pv ')) {
      const m = line.match(/score (cp|mate) (-?\d+).* pv (\S+)/);
      if (m) this.info = { type: m[1], value: Number(m[2]), pv: m[3] };
    } else if (line.startsWith('bestmove')) {
      this.finish(line.split(' ')[1]);
    }
  }

  finish(move) {
    const r = this.resolve;
    this.resolve = null;
    r?.({ move: move && move !== '(none)' ? move : null, info: this.info });
  }

  newGame() {
    this.ready.then(() => this.post('ucinewgame')).catch(() => {});
  }

  /** opts: {skill 0-20, depth?, movetime?} -> Promise<{move, info}> */
  search(fen, opts) {
    const run = async () => {
      await this.ready;
      return new Promise((resolve) => {
        this.resolve = resolve;
        this.info = null;
        this.post(`setoption name Skill Level value ${opts.skill ?? 20}`);
        this.post(`position fen ${fen}`);
        this.post(opts.movetime ? `go movetime ${opts.movetime}` : `go depth ${opts.depth || 10}`);
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  stop() {
    if (this.resolve) this.post('stop');
  }
}
