import {messages} from '../../shared/messages.js';

export class Player {
  constructor({avplay, video, userAgent = globalThis.navigator?.userAgent, width = 1920, height = 1080, onProgress = () => {}, onState = () => {}, onError = () => {}}) {
    Object.assign(this, {avplay, video, userAgent, width, height, onProgress, onState, onError});
    this.state = 'closed';
    this.position = 0;
    this.duration = 0;
    this.epoch = 0;
    this.queue = Promise.resolve();
    this.nativeOpen = false;
    this.cancelLoad = null;
  }

  enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result;
    return result;
  }

  setState(state) { this.state = state; this.onState(state); }

  progress(milliseconds) {
    this.position = Math.max(0, milliseconds / 1000);
    this.onProgress(this.position);
  }

  release() {
    if (this.nativeOpen) { this.avplay.close(); this.nativeOpen = false; }
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
  }

  open(source, seconds = 0, paused = false) {
    const epoch = ++this.epoch;
    this.cancelLoad?.();
    this.position = Math.max(0, seconds);
    this.setState('loading');
    return this.enqueue(async () => {
      this.release();
      if (epoch !== this.epoch) return;
      try {
        if (this.avplay) {
          this.avplay.open(source.url);
          this.nativeOpen = true;
          if (this.userAgent) this.avplay.setStreamingProperty('USER_AGENT', this.userAgent);
          this.avplay.setDisplayRect(0, 0, this.width, this.height);
          this.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
          this.avplay.setListener({
            oncurrentplaytime: ms => { if (epoch === this.epoch && this.state !== 'error') this.progress(ms); },
            onstreamcompleted: () => { if (epoch === this.epoch && this.state !== 'error') this.setState('ended'); },
            onerror: () => { if (epoch === this.epoch) { this.setState('error'); this.onError(Object.assign(new Error(messages.en.native_video_error), {messageKey: 'native_video_error'})); } },
            onbufferingstart: () => { if (epoch === this.epoch && this.state !== 'error') this.onState('buffering'); },
            onbufferingcomplete: () => { if (epoch === this.epoch && this.state !== 'error') this.onState(this.state); },
          });
          await new Promise((resolve, reject) => this.avplay.prepareAsync(resolve, reject));
          if (epoch !== this.epoch || this.state === 'error') return;
          this.duration = this.avplay.getDuration() / 1000;
          this.position = this.clamp(seconds);
          if (this.position > 0) await this.nativeSeek(this.position);
          if (epoch !== this.epoch || this.state === 'error') return;
          this.avplay.play();
          if (paused) this.avplay.pause();
        } else {
          await this.loadVideo(source.url);
          if (epoch !== this.epoch) return;
          this.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
          this.video.currentTime = this.position = this.clamp(seconds);
          this.video.ontimeupdate = () => { if (epoch === this.epoch && this.state !== 'error') this.progress(this.video.currentTime * 1000); };
          this.video.onended = () => { if (epoch === this.epoch && this.state !== 'error') this.setState('ended'); };
          this.video.onerror = () => { if (epoch === this.epoch) { this.setState('error'); this.onError(Object.assign(new Error(messages.en.browser_video_error), {messageKey: 'browser_video_error'})); } };
          if (!paused) await this.video.play();
        }
        if (epoch === this.epoch && this.state !== 'error') this.setState(paused ? 'paused' : 'playing');
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.setState('error');
        throw Object.assign(new Error(messages.en.video_open_error, {cause: error}), {messageKey: 'video_open_error'});
      }
    });
  }

  loadVideo(url) {
    return new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', ready);
        this.video.removeEventListener('error', failed);
        this.cancelLoad = null;
        if (error) reject(error); else resolve();
      };
      const ready = () => done();
      const failed = () => done(new Error('Unsupported video'));
      const timer = setTimeout(failed, 25000);
      this.cancelLoad = failed;
      this.video.addEventListener('loadedmetadata', ready);
      this.video.addEventListener('error', failed);
      this.video.src = url;
      this.video.load();
    });
  }

  clamp(seconds) { return Math.max(0, Math.min(seconds, this.duration > 0 ? Math.max(0, this.duration - 0.5) : seconds)); }
  nativeSeek(seconds) {
    return new Promise((resolve, reject) => {
      const failed = error => reject(Object.assign(new Error(messages.en.video_seek_error, {cause: error}), {messageKey: 'video_seek_error'}));
      try { this.avplay.seekTo(Math.round(seconds * 1000), resolve, failed); }
      catch (error) { failed(error); }
    });
  }

  toggle() {
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (epoch !== this.epoch || !['playing', 'paused', 'ended'].includes(this.state)) return;
      if (this.state === 'ended') {
        if (this.avplay) await this.nativeSeek(0); else this.video.currentTime = 0;
        if (epoch !== this.epoch) return;
        this.position = 0;
        if (this.avplay) this.avplay.play(); else await this.video.play();
        this.setState('playing'); return;
      }
      const pause = this.state === 'playing';
      if (this.avplay) { if (pause) this.avplay.pause(); else this.avplay.play(); }
      else { if (pause) this.video.pause(); else await this.video.play(); }
      this.setState(pause ? 'paused' : 'playing');
    });
  }

  seek(seconds, {absolute = false} = {}) {
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (epoch !== this.epoch || !['playing', 'paused', 'ended'].includes(this.state)) return;
      const ended = this.state === 'ended';
      const target = this.clamp(absolute ? seconds : this.position + seconds);
      if (this.avplay) await this.nativeSeek(target); else this.video.currentTime = target;
      if (epoch === this.epoch) {
        this.progress(target * 1000);
        if (ended) { if (this.avplay) this.avplay.play(); else await this.video.play(); this.setState('playing'); }
      }
    });
  }

  close() {
    ++this.epoch;
    this.cancelLoad?.();
    this.setState('closed');
    return this.enqueue(() => this.release());
  }
}
