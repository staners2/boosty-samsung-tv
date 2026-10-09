export class FramePreview {
  constructor({request, onChange, delay = 250, now = Date.now}) {
    this.request = request; this.onChange = onChange; this.delay = delay; this.now = now;
    this.epoch = 0; this.timer = null; this.controller = null;
    this.cache = new Map(); this.scope = null; this.pending = null; this.selection = null;
  }
  clear({keepCache = false} = {}) {
    this.epoch++; clearTimeout(this.timer); this.controller?.abort(); this.controller = null;
    this.pending = null; this.selection = null;
    if (!keepCache) { this.cache.clear(); this.scope = null; }
    this.onChange({status: 'hidden', target: null, image: null});
  }
  key(target) { return JSON.stringify([target.blog, target.postId, target.videoId, target.seconds]); }
  cached(target) {
    const key = this.key(target), entry = this.cache.get(key);
    if (!entry) return null;
    this.cache.delete(key);
    if (entry.expiresAt <= this.now()) return null;
    this.cache.set(key, entry); return entry.image;
  }
  nearest(target) {
    let nearest = null;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= this.now()) { this.cache.delete(key); continue; }
      const [blog, postId, videoId, seconds] = JSON.parse(key);
      if (blog !== target.blog || postId !== target.postId || videoId !== target.videoId) continue;
      if (!nearest || Math.abs(seconds-target.seconds) < Math.abs(nearest.frameSeconds-target.seconds)) {
        nearest = {image: entry.image, frameSeconds: seconds};
      }
    }
    return nearest;
  }
  load(target, epoch, signal) {
    const pending = {key: this.key(target), signal};
    pending.promise = (async () => {
      const result = await this.request(target, signal);
      if (epoch !== this.epoch || signal.aborted) return null;
      if (result.seconds !== target.seconds || typeof result.image !== 'string' || result.image.length > 88 * 1024
        || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.image)) throw new Error('Invalid preview');
      const key = this.key(target), now = this.now();
      this.cache.delete(key);
      this.cache.set(key, {image: result.image, expiresAt: now+300000, bytes: (key.length+result.image.length)*2});
      let bytes = 0;
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key); else bytes += entry.bytes;
      }
      while (this.cache.size > 32 || bytes > 4*1024*1024) {
        const oldest = this.cache.keys().next().value;
        bytes -= this.cache.get(oldest).bytes; this.cache.delete(oldest);
      }
      return result.image;
    })();
    this.pending = pending;
    return pending.promise.finally(() => { if (this.pending === pending) this.pending = null; });
  }
  prefetch(target, nearby, epoch, signal) {
    const keys = new Set([this.key(target)]);
    const selections = nearby.filter(candidate => {
      if (candidate.blog !== target.blog || candidate.postId !== target.postId || candidate.videoId !== target.videoId
        || !Number.isFinite(candidate.seconds) || candidate.seconds < 0) return false;
      const key = this.key(candidate); if (keys.has(key)) return false;
      keys.add(key); return true;
    }).slice(0, 4);
    if (!selections.length) return;
    const selection = this.selection;
    this.timer = setTimeout(async () => {
      for (const candidate of selections) {
        if (selection !== this.selection || epoch !== this.epoch || signal.aborted) return;
        if (this.cached(candidate)) continue;
        try { await this.load(candidate, epoch, signal); }
        catch (error) {
          if (selection !== this.selection || epoch !== this.epoch || signal.aborted) return;
          if ([401, 403].includes(error.status)) {
            this.clear(); this.onChange({status: 'error', target, image: null}); return;
          }
          // A failed speculative frame must not replace the user's selected frame.
        }
      }
    }, 100);
  }
  async finish(promise, selection, epoch, signal) {
    const {target, nearby} = selection;
    try {
      const image = await promise;
      if (!image || selection !== this.selection || epoch !== this.epoch || signal.aborted) return;
      this.onChange({status: 'ready', target, image}); this.prefetch(target, nearby, epoch, signal);
    } catch (error) {
      if (selection !== this.selection || epoch !== this.epoch || signal.aborted) return;
      if ([401, 403].includes(error.status)) this.clear();
      this.onChange({status: 'error', target, image: null});
    }
  }
  select(target, nearby = []) {
    const scope = JSON.stringify([target.blog, target.postId]);
    const pending = this.pending?.key === this.key(target) && !this.pending.signal.aborted ? this.pending : null;
    if (pending) clearTimeout(this.timer);
    else this.clear({keepCache: scope === this.scope});
    this.scope = scope;
    const epoch = this.epoch;
    const selection = {target, nearby}; this.selection = selection;
    if (!target.videoId) { this.onChange({status: 'error', target, image: null}); return; }
    if (pending) {
      const nearest = this.nearest(target);
      this.onChange({status: nearest ? 'cached' : 'loading', target, image: null, ...nearest});
      void this.finish(pending.promise, selection, epoch, pending.signal); return;
    }
    const controller = new AbortController(); this.controller = controller;
    const cached = this.cached(target);
    if (cached) {
      this.onChange({status: 'ready', target, image: cached}); this.prefetch(target, nearby, epoch, controller.signal); return;
    }
    const nearest = this.nearest(target);
    this.onChange({status: nearest ? 'cached' : 'loading', target, image: null, ...nearest});
    this.timer = setTimeout(() => {
      void this.finish(this.load(target, epoch, controller.signal), selection, epoch, controller.signal);
    }, this.delay);
  }
}
