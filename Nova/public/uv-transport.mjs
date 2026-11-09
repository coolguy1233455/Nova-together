// Ultraviolet's transport (run by bare-mux's worker), wrapped to add Nova's request
// preferences: see /request-prefs.mjs.
import { withPreferences } from "/request-prefs.mjs";

export default class PreferencesTransport {
  constructor({ base, options }) {
    this.base = base;
    this.options = options;
    this.inner = null;
    this.ready = false;
  }

  async init() {
    const Inner = (await import(this.base)).default;
    this.inner = new Inner(this.options);
    if (!this.inner.ready) await this.inner.init();
    this.ready = true;
  }

  meta() {
    return this.inner.meta?.();
  }

  request(remote, method, body, headers, signal) {
    return this.inner.request(remote, method, body, withPreferences(remote, headers), signal);
  }

  connect(...args) {
    return this.inner.connect(...args);
  }
}
