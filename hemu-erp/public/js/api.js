/* API 客户端：fetch 封装 + 会话 */
export const API = {
  get token() { return localStorage.getItem('hemu_token') || ''; },
  set token(v) { v ? localStorage.setItem('hemu_token', v) : localStorage.removeItem('hemu_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('hemu_user') || 'null'); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('hemu_user', JSON.stringify(v)) : localStorage.removeItem('hemu_user'); },

  async req(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error('网络不可用，请检查连接后重试');
    }
    if (res.status === 401) {
      this.token = ''; this.user = null;
      location.hash = '#/login';
      throw new Error('登录已过期，请重新登录');
    }
    const json = await res.json().catch(() => ({ code: 1, message: '服务异常' }));
    if (json.code !== 0) throw new Error(json.message || '操作失败');
    return json.data;
  },
  get(url) { return this.req('GET', url); },
  post(url, body) { return this.req('POST', url, body || {}); },
  put(url, body) { return this.req('PUT', url, body || {}); },
};
