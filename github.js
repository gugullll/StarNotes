'use strict';

/* =========================================================
   github.js · 绑定一个 GitHub 仓库，并双向同步笔记

   浏览器不能跑 git，所以这里走 GitHub REST API：一个 token
   + 一个 owner/repo 就是全部凭据。绑定时按顺序校验四件事，
   每一步失败都给一句「为什么」和一句「怎么办」：

     1. 本地字段（地址能不能看懂、分支、token、作者、邮箱）
     2. GET /user            → token 还活着吗
     3. GET /repos/{o}/{r}   → 看得见这个仓库吗、有没有写权限
     4. GET /git/ref/heads/{b} → 分支在不在（空仓库单独认）

   同步刻意不做「合并」：只有「推送」和「拉取」两个方向，
   都是整份覆盖。动手之前先比对一遍，把「会消失的文件」列出来。
   覆盖比合并诚实——你点下去就知道结果是什么。

   整段包在 IIFE 里：app.js 是普通脚本，顶层声明（$、state…）
   都落在全局词法环境，这里再声明同名变量会直接 SyntaxError。
   ========================================================= */

(() => {
  const API = 'https://api.github.com';
  const TIMEOUT = 10000;        // 第一次给 10s：跨洋正常只要几百毫秒
  const RETRY_TIMEOUT = 15000;  // 重试放宽一点，慢网络有机会过
  const DB_NAME = 'starnote-gh';
  const STORE = 'bind';
  const SNAP = 'snap';          // 拉取前的本地快照
  const DB_VERSION = 2;
  const KEY = 'current';
  const SYNC_KEY = 'pull';      // 快照键名：只保留最近 3 次拉取
  const CONCURRENCY = 4;        // 同时开几个请求，GitHub 不吃这一套但我们别太贪

  const $ = (s) => document.querySelector(s);
  const say = (t) => { if (window.StarNotes?.flash) window.StarNotes.flash(t); };

  let cur = null;        // 当前绑定
  let busy = false;
  let probing = false;   // 静默复检进行中
  let noticed = false;   // 本次会话已经提醒过一次过期
  let closeTimer = 0;
  /* 绑定成功后 1.1 秒会自动收起面板。只要人在这期间动了同步区（比对、历史和
     回退、推送…），就必须取消这个定时器 —— 否则面板会在他手底下关掉，
     状态提示连同结果一起消失。 */
  const keepOpen = () => { clearTimeout(closeTimer); };

  /* ---------------- 本地存储：IndexedDB（不放 localStorage） ---------------- */

  let mem = null;        // IDB 不可用时的兜底，本次会话有效

  function idb() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(SNAP)) db.createObjectStore(SNAP);
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error('IndexedDB 打不开'));
    });
  }

  async function store(op, fn, name) {
    const db = await idb();
    const sn = name || STORE;
    return new Promise((res, rej) => {
      const tx = db.transaction(sn, op === 'get' ? 'readonly' : 'readwrite');
      const r = fn(tx.objectStore(sn));
      tx.oncomplete = () => res(r && 'result' in r ? r.result : r);
      tx.onerror = () => rej(tx.error);
    });
  }

  async function loadBind() {
    try { cur = (await store('get', (s) => s.get(KEY))) || null; } catch (e) { cur = mem; }
    return cur;
  }

  async function saveBind(v) {
    mem = v; cur = v;
    try { await store('put', (s) => s.put(v, KEY)); } catch (e) { /* 存不下就只在本次会话里有效 */ }
  }

  async function clearBind() {
    mem = null; cur = null;
    try { await store('put', (s) => (s.delete ? s.delete(KEY) : null)); } catch (e) { /* ignore */ }
  }

  /* ---------------- 仓库地址解析 ---------------- */

  /* 认这些写法：
       owner/repo
       https://github.com/owner/repo(.git)(/tree/main)(?tab=readme…)
       git@github.com:owner/repo.git
       github.com/owner/repo                                        */
  function parseRepo(raw) {
    let s = String(raw || '').trim();
    if (!s) return { reason: '还没填仓库地址', hint: '形如 owner/repo，或直接粘 GitHub 页面上的地址' };

    // 先说清「不是 GitHub」：https://gitlab.com/x、git@gitlab.com:x 这类
    const foreign = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:git@)?|git@)([^/:\s]+)[/:]/i.exec(s);
    if (foreign && !/^(www\.)?github\.com$/i.test(foreign[1])) {
      return { reason: '只支持 github.com 的仓库', hint: '你填的是 ' + foreign[1] + '，这个功能只对接 GitHub' };
    }

    s = s.replace(/^git@github\.com:/i, '')
      .replace(/^ssh:\/\/git@github\.com\//i, '')
      .replace(/^[a-z]+:\/\/(www\.)?github\.com\//i, '')
      .replace(/^(www\.)?github\.com\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/\.git\/?$/i, '')
      .replace(/^\/+|\/+$/g, '');

    const parts = s.split('/').filter(Boolean);
    if (parts.length < 2) return { reason: '仓库地址看不懂：' + raw.trim(), hint: '需要 owner/repo 两段，例如 gugullll/StarNotes' };

    const owner = parts[0];
    const repo = parts[1];
    const okName = /^[\w.-]+$/;
    if (!okName.test(owner) || !okName.test(repo)) {
      return { reason: '仓库地址里有不认识的字符：' + owner + '/' + repo, hint: '地址里别带 /tree/main、/issues 这类页面路径' };
    }
    return { owner, repo, extra: parts.length > 2 ? parts.slice(2).join('/') : '' };
  }

  /* ---------------- HTTP ---------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function once(path, token, ms, opt) {
    const o = opt || {};
    const ctrl = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (o.body) headers['Content-Type'] = 'application/json';
    try {
      const res = await fetch(API + path, {
        method: o.method || 'GET',
        signal: ctrl.signal,
        headers,
        body: o.body ? JSON.stringify(o.body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return {
        status: res.status, ok: res.ok, data, headers: res.headers,
        expiry: readExpiry(res.headers), ms: Date.now() - t0,
      };
    } catch (e) {
      return {
        status: 0, ok: false, ms: Date.now() - t0, wait: ms,
        net: e && e.name === 'AbortError' ? 'timeout' : 'offline',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /* 网络断一下、慢一下是常态，4xx 是「GitHub 明确拒绝」，这两种要分开对待：
     前者值得悄悄再来一次，后者再来一百次也一样。 */
  const worthRetry = (r) => !!r.net || r.status >= 500;

  /* 重试对写操作也安全：blob 是按内容寻址的，tree/commit 重复创建只是多几个
     没人引用的对象，PATCH ref 用同一个 sha 是幂等的。真正会出问题的是
     「响应丢了但请求成功了」——那种情况重试也只会得到同样的结果。 */
  async function api(path, token, opt) {
    let r = await once(path, token, TIMEOUT, opt);
    let tries = 1;
    if (worthRetry(r)) {
      await sleep(500);
      r = await once(path, token, RETRY_TIMEOUT, opt);
      tries = 2;
    }
    r.tries = tries;
    return r;
  }

  /* okBefore：同一个域名上一个请求刚成功过。这时的「连不上」基本不是网络断了，
     而是这一条被拦（扩展 / 代理规则 / 安全软件），文案要指对方向。 */
  function netFail(r, what, okBefore) {
    const secs = ((r.wait || r.ms || 0) / 1000).toFixed(0);
    const more = r.tries > 1 ? '，自动重试了 ' + (r.tries - 1) + ' 次' : '';
    if (r.net === 'timeout') {
      return fail('连 GitHub 超时（' + what + '）',
        '这个请求 ' + secs + ' 秒没响应' + more + '。' +
        (okBefore
          ? '前一个请求还是通的，多半只是这一条特别慢，点「校验并绑定」再试一次'
          : '网络或代理不稳，点「校验并绑定」再试一次'));
    }
    return fail('连不上 api.github.com（' + what + '）',
      okBefore
        ? '同一个域名上一个请求刚成功，网络应该没断，更像是这一条被拦住了（浏览器扩展、代理规则、安全软件）' + more + '。点「校验并绑定」再试一次'
        : '检查网络或代理，公司网络有时会拦 GitHub API' + more + '。点「校验并绑定」可以重试');
  }

  /* GitHub 在任何「已认证且带到期时间」的响应上都会挂
     GitHub-Authentication-Token-Expiration，这是唯一能读到到期日的地方
     （没有 /token-info 这类端点）。两种写法都见过：
       classic     2026-12-01 10:00:00 UTC
       fine-grained 2026-12-01 10:00:00 +0100                         */
  function parseExpiry(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (!m) {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
    let off = 0;
    const tz = m[7];
    if (tz && !/^(UTC|Z)$/i.test(tz)) {
      const z = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
      if (z) off = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
    }
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000;
  }

  /* 已知 bug：fine-grained token 有时把「服务器当前时间」当成到期时间返回。
     这种值永远贴着眼下的钟，绝不能拿它判断过期，否则每次打开都误报。
     所以离现在不到 5 分钟的一律视为「读不到」，退回 401 来判断。 */
  function readExpiry(headers) {
    const raw = headers?.get?.('github-authentication-token-expiration');
    const ts = parseExpiry(raw);
    if (!ts || ts <= Date.now() + 5 * 60000) return null;
    return ts;
  }

  const remaining = (r) => {
    const v = r?.headers?.get?.('x-ratelimit-remaining');
    return v === null || v === undefined ? null : Number(v);
  };

  const detail = (r) => (r?.data && (r.data.message || r.data.error)) || '';

  const fail = (reason, hint) => ({ ok: false, reason, hint: hint || '' });

  const branchPath = (b) => b.split('/').map(encodeURIComponent).join('/');

  /* ---------------- 写权限 ----------------

     GET /repos/{o}/{r} 里的 permissions.push 回答不了「这个 token 能写吗」——
     它是「你这个人对这个仓库有没有写权限」，和 fine-grained token 被授予的
     Contents 权限是两层东西。只读 token 在这里照样看到 push:true，然后
     POST /git/blobs 才返回 403 Resource not accessible by personal access token。
     也就是说：**没有只读的接口能问出 token 的写入范围，只能真写一次。**

     所以这里建一个 26 字节的 blob 当探测。它不进 tree、不进 commit，仓库
     页面上看不见，也不计入仓库大小（悬空对象）。内容固定 → sha 固定 →
     反复探测永远只有一个对象，成本就是一次请求。 */
  const PROBE_TEXT = 'StarNotes write probe\n';

  /* 返回 { known, readonly } 或 { known:false, net|error }：
     known:false 表示「这一次问不出来」（网络抖、限流），不该当成只读。 */
  async function writeProbe(base, token) {
    const r = await api(base + '/git/blobs', token, {
      method: 'POST', body: { content: PROBE_TEXT, encoding: 'utf-8' },
    });
    if (r.ok) return { known: true, readonly: false };
    if (r.net) return { known: false, net: r };
    if (r.status === 403 && remaining(r) === 0) {
      return { known: false, error: fail('GitHub 限流了，这次没测出写权限', '这一小时的请求用完了，等一会儿再校验') };
    }
    if (r.status === 403 && isNoScope(r)) return { known: true, readonly: true };
    if (r.status === 401) {
      return { known: false, error: fail('Token 被拒绝了（401）', '重新生成一个再校验') };
    }
    return {
      known: false,
      error: fail('没能确认写权限（HTTP ' + r.status + '）', detail(r) || '这不算错，只是没测出来，推送时会再遇到'),
    };
  }

  /* fine-grained token 缺 Contents:Write 时 GitHub 的原话 */
  const isNoScope = (r) => /not accessible by personal access token/i.test(String(detail(r) || ''));

  /* 写入类请求的失败文案。403 有四种完全不同的原因，全看 message 区分：
     没写权限 / 分支保护 / 限流 / 其它。含糊地说「403」等于什么都没说。 */
  function writeFail(what, r) {
    const msg = String(detail(r) || '');
    if (r.status === 403) {
      if (remaining(r) === 0) {
        return fail('GitHub 限流了（' + what + '）', '这个 token 这一小时的请求用完了，等一会儿再试');
      }
      if (isNoScope(r)) {
        // 不点具体文件名：这是整个 token 没写权限，不是那个文件有问题。
        // 也不用让人「重新生成」—— fine-grained token 的权限页现在可以原地
        // 改仓库范围、权限、有效期，token 字符串不变。
        return fail('这个 Token 没有写权限',
          '它现在只能读。去 GitHub 的 token 设置里开写权限：fine-grained 把 Repository permissions → ' +
          'Contents 改成 Read and write，classic 勾上 repo。保存后回来点「校验并绑定」重试，' +
          '多数情况 token 本身不用换（页面只给 Regenerate 的话，就重新生成一个粘进来）');
      }
      if (/protected branch|branch protection|required status/i.test(msg)) {
        return fail('「' + (cur?.branch || '') + '」这个分支受保护，写不进去',
          '在仓库 Settings → Branches 里放宽规则，或者在面板里换一个没被保护的分支');
      }
      return fail(what + '被拒绝（HTTP 403）', msg || 'token 权限或分支保护规则挡住了这次写入');
    }
    return fail(what + '失败（HTTP ' + r.status + '）', detail(r) || 'GitHub 返回了 ' + r.status + '，隔一会儿再试一次');
  }

  /* ---------------- 校验 ---------------- */

  async function verify(cfg, onStep) {
    const step = (k, s) => { try { if (onStep) onStep(k, s); } catch (e) { /* 进度回调出错不该影响校验 */ } };

    /* 1. 先在本地拦：不发请求就能说清楚的问题，别浪费一次往返 */
    const repo = parseRepo(cfg.repo);
    if (!repo.owner) return fail(repo.reason, repo.hint);

    const branch = String(cfg.branch || '').trim();
    if (!branch) return fail('分支名不能为空', '不知道推到哪里的话，填 main 或 master');

    const token = String(cfg.token || '').trim();
    if (!token) return fail('还没填 Token', 'GitHub → Settings → Developer settings → Personal access tokens');
    if (/\s/.test(cfg.token)) return fail('Token 里混了空格或换行', '重新复制一次，注意别把首尾空白带进来');

    const author = String(cfg.author || '').trim();
    if (!author) return fail('作者名要填', '提交记录里会显示这个名字');

    const email = String(cfg.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('邮箱格式不对', '形如 you@example.com，GitHub 用它把提交算到你名下');

    /* 2. token 本身有效吗 */
    step('user', 'run');
    const me = await api('/user', token);
    if (me.net) return netFail(me, '/user');
    if (me.status === 401) {
      const when = me.expiry || (cur && cur.expiresAt) || null;
      if (when && when <= Date.now()) {
        return fail('Token 已于 ' + fmtDate(when) + ' 过期',
          '去 GitHub 重新生成一个，粘到下面点「校验并绑定」；其他字段不用改');
      }
      if (when) {
        return fail('Token 被拒绝了（401）',
          '它本该 ' + fmtDate(when) + ' 才到期，现在就被拒，通常是已被删除或重置，重新生成一个');
      }
      return fail('Token 无效或已过期', '重新生成一个 fine-grained token，权限给 Contents: Read and write');
    }
    if (me.status === 403) {
      return remaining(me) === 0
        ? fail('GitHub 限流了', '这个 token 这一小时的请求用完了，等一会儿再试')
        : fail('Token 被拒绝（403）', detail(me) || '确认 token 没有过期、没有被吊销');
    }
    if (!me.ok) return fail('读当前账号失败（HTTP ' + me.status + '）', detail(me) || 'GitHub 返回了 ' + me.status + '，隔一会儿再试一次即可');
    step('user', 'ok');

    /* 3. 仓库能不能看见、能不能写 */
    step('repo', 'run');
    const path = '/repos/' + repo.owner + '/' + repo.repo;
    const rp = await api(path, token);
    if (rp.net) return netFail(rp, path, true);
    if (rp.status === 404) {
      return fail('找不到这个仓库：' + repo.owner + '/' + repo.repo,
        'fine-grained token 要把该仓库加进 Repository access；地址里的 owner/repo 再核对一遍');
    }
    if (rp.status === 403) {
      return fail('这个 token 没权限访问该仓库', '组织仓库开了 SSO 时，还要在组织设置里点 Authorize；也可能是限流');
    }
    if (!rp.ok) return fail('读仓库信息失败（HTTP ' + rp.status + '）', detail(rp) || 'GitHub 返回了 ' + rp.status + '，隔一会儿再试一次即可');

    const info = rp.data || {};
    if (info.archived) return fail('仓库已归档，写不进去', '在仓库 Settings 里取消 Archive 之后再绑定');
    if (info.permissions && info.permissions.push === false) {
      return fail('你在这个仓库上没有写权限',
        '只能推送自己名下有写权限的仓库；如果这是别人的仓库，先让对方给你 Write 权限');
    }
    step('repo', 'ok');

    /* 4. 真的能写吗 —— 必须真发一次写请求，见 writeProbe 的注释。
       测出只读**不阻断绑定**：读是通的，拉取现在就能用，只是推送会被拒。
       把它标出来、把推送按钮关上，比让人点一次才 403 好。 */
    step('write', 'run');
    const wp = await writeProbe(path, token);
    const ro = !!(wp.known && wp.readonly);
    step('write', wp.known && !wp.readonly ? 'ok' : 'skip');
    const base = {
      owner: repo.owner, repo: repo.repo, branch, login: me.data?.login || '',
      expiresAt: me.expiry || null, readonly: ro,
    };

    /* 5. 分支在不在；空仓库单独认
       路径必须挂在 /repos/{owner}/{repo} 下：少了前缀 GitHub 对 OPTIONS 预检
       回 404 且不带 allow-headers，浏览器直接抛 Failed to fetch——
       看起来像「连不上网」，其实只是 URL 写错了。 */
    step('ref', 'run');
    const refPath = path + '/git/ref/heads/' + branchPath(branch);
    const ref = await api(refPath, token);

    /* 分支这一步被网络卡住时不让整次绑定失败：前两步已经证明 token 有效、
       有写权限，这两件事才是绑定要确认的。分支留到第一次推送时再见真章。 */
    if (ref.net) {
      step('ref', 'skip');
      return {
        ok: true,
        soft: netFail(ref, refPath, true),
        info: { ...base, commit: null, empty: false, branchUnchecked: true },
      };
    }

    if (ref.status === 404) {
      const listPath = path + '/git/refs/heads?per_page=100';
      const all = await api(listPath, token);
      if (all.net) return netFail(all, listPath, true);
      const names = Array.isArray(all.data) ? all.data.map((x) => String(x.ref || '').replace('refs/heads/', '')) : [];
      if (all.ok && names.length === 0) {
        step('ref', 'ok');
        return {
          ok: true,
          info: { ...base, commit: null, empty: true },
        };
      }
      if (names.length) {
        return fail('分支「' + branch + '」不存在', '这个仓库现有：' + names.slice(0, 6).join('、') + (names.length > 6 ? ' …' : ''));
      }
      return fail('读不到分支列表', detail(all) || '仓库可能是空的，或 token 缺少 Contents 权限');
    }
    if (!ref.ok) return fail('读分支失败（HTTP ' + ref.status + '）', detail(ref) || 'GitHub 返回了 ' + ref.status + '，隔一会儿再试一次即可');
    step('ref', 'ok');

    return { ok: true, info: { ...base, commit: ref.data?.object?.sha || null, empty: false } };
  }

  /* ---------------- 同步：比对 / 推送 / 拉取 ----------------

     只做两个方向，都是整份覆盖，不合并：

       推送 = 远端变成和本地一样（远端多出来的会被删）
       拉取 = 本地变成和远端一样（本地多出来的会被删）

     能这么干的前提是「动手之前把会消失的东西列清楚」，所以两个
     动作都先跑一遍比对，把「只在本地 / 只在远端 / 内容不同」分开摆。

     同时只碰 .md：图片、.gitattributes、.github/ 这些既不读也不删，
     误删的爆炸半径就限定在笔记范围内。
     -------------------------------------------------------- */

  const ENTRY = { mode: '100644', type: 'blob' };

  /* 参与同步的文件：一层 .md，且路径里没有以 . 开头的段 */
  function isManaged(p) {
    const segs = String(p).split('/');
    if (segs.some((s) => !s || s.startsWith('.'))) return false;
    return /\.md$/i.test(p);
  }

  /* Windows 下用别的编辑器存一次就成 CRLF。不归一化的话同一个文件
     永远显示「两边都不同」，比对表全是噪音——因为哈希变了。 */
  const normEol = (s) => String(s).replace(/\r\n/g, '\n');

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    const bin = unescape(encodeURIComponent(s));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 纯 JS 的 SHA-1。用 crypto.subtle 也行，但它是异步的、还要求安全上下文；
     git 的 blob 哈希算法本身很短，自己算一遍反而少一层环境依赖。 */
  function sha1hex(buf) {
    const ml = buf.length;
    const padded = new Uint8Array((((ml + 8) >> 6) + 1) * 64);
    padded.set(buf);
    padded[ml] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(ml / 536870912), false);
    dv.setUint32(padded.length - 4, (ml * 8) >>> 0, false);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Uint32Array(80);
    for (let i = 0; i < padded.length; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
      for (let j = 16; j < 80; j++) {
        const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
        w[j] = ((x << 1) | (x >>> 31)) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const t = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[j]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  /* git 的 blob 哈希 = sha1("blob " + 字节数 + "\0" + 内容)。
     远端返回的 sha 就是这个，本地算同一个才能不下载就比对。 */
  function blobSha(text) {
    const body = utf8(text);
    const head = utf8('blob ' + body.length + '\u0000');
    const all = new Uint8Array(head.length + body.length);
    all.set(head, 0);
    all.set(body, head.length);
    return sha1hex(all);
  }

  function fromBase64(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    if (typeof TextDecoder !== 'undefined') {
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(escape(bin));
  }

  async function pool(items, n, fn) {
    const arr = [...items];
    let i = 0;
    const run = async () => {
      while (i < arr.length) {
        const k = i++;
        await fn(arr[k], k);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, arr.length) }, run));
  }

  const boom = (r) => { const e = new Error(r.reason); e.fail = r; throw e; };

  /* ---- 本地 ---- */

  async function collectLocal(root) {
    const out = new Map();
    const walk = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (!name || name.startsWith('.')) continue;
        const p = prefix ? prefix + '/' + name : name;
        if (h.kind === 'directory') { await walk(h, p); continue; }
        if (!/\.md$/i.test(name)) continue;
        try {
          const text = normEol(await (await h.getFile()).text());
          out.set(p, { text, sha: blobSha(text) });
        } catch (e) { /* 单个文件读不出来就跳过，别让整次同步挂掉 */ }
      }
    };
    await walk(root, '');
    return out;
  }

  async function ensureDir(root, path) {
    const segs = path.split('/');
    let dir = root;
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
    return { dir, name: segs[segs.length - 1] };
  }

  async function writeTextTo(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  async function removeLocal(root, path) {
    try {
      const segs = path.split('/');
      let dir = root;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
      await dir.removeEntry(segs[segs.length - 1]);
      return true;
    } catch (e) { return false; }
  }

  /* 远端删掉一整块画布后，本地别留一个空文件夹（那会变成一块空画布）。
     只清理「因为这次删除而变空」的祖先目录，不碰用户自己建的空画布。 */
  async function pruneEmptyDirs(root, paths) {
    const prefixes = new Set();
    for (const p of paths) {
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) prefixes.add(segs.slice(0, i).join('/'));
    }
    const deep = [...prefixes].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const d of deep) {
      const segs = d.split('/');
      try {
        let parent = root;
        for (const s of segs.slice(0, -1)) parent = await parent.getDirectoryHandle(s);
        const self = await parent.getDirectoryHandle(segs[segs.length - 1]);
        let empty = true;
        for await (const _ of self.entries()) { empty = false; break; }
        if (empty) await parent.removeEntry(segs[segs.length - 1]);
      } catch (e) { /* 已经没了、或者删不掉，都不算问题 */ }
    }
  }

  /* ---- 远端 ---- */

  async function remoteState(bind) {
    const base = '/repos/' + bind.owner + '/' + bind.repo;
    const refPath = base + '/git/ref/heads/' + branchPath(bind.branch);
    const ref = await api(refPath, bind.token);
    if (ref.net) return { error: netFail(ref, refPath) };
    if (ref.status === 401) return { error: fail('Token 被拒绝了（401）', '重新生成一个再绑定一次') };

    if (ref.status === 404) {
      // 分支不存在，也可能整个仓库都不存在。多问一句，别把东西推到一个
      // 拼错的仓库名下面（那样会新建一个分支，看起来还挺成功）。
      const rp = await api(base, bind.token);
      if (rp.net) return { error: netFail(rp, base, true) };
      if (rp.status === 404) {
        return { error: fail('找不到仓库 ' + bind.owner + '/' + bind.repo, '地址、token 的 Repository access 都要对得上') };
      }
      /* 仓库在、但分支不在：多半是分支名写错了。这时如果直接当空仓库处理，
         推送会「成功」地新建一个垃圾分支，所以要先把现有分支报出来。 */
      const listPath = base + '/git/refs/heads?per_page=100';
      const all = await api(listPath, bind.token);
      if (all.net) return { error: netFail(all, listPath, true) };
      const names = Array.isArray(all.data)
        ? all.data.map((x) => String(x.ref || '').replace('refs/heads/', '')) : [];
      if (names.length) {
        return {
          error: fail('分支「' + bind.branch + '」不存在',
            '这个仓库现有：' + names.slice(0, 6).join('、') + '。改对分支名再重新绑定一次'),
        };
      }
      return { empty: true, head: null, tree: null, files: new Map() };
    }
    if (!ref.ok) return { error: fail('读分支失败（HTTP ' + ref.status + '）', detail(ref)) };

    const head = ref.data?.object?.sha;
    const cm = await api(base + '/git/commits/' + head, bind.token);
    if (cm.net) return { error: netFail(cm, base + '/git/commits/' + head, true) };
    if (!cm.ok) return { error: fail('读最新提交失败（HTTP ' + cm.status + '）', detail(cm)) };

    const treeSha = cm.data?.tree?.sha;
    const tr = await api(base + '/git/trees/' + treeSha + '?recursive=1', bind.token);
    if (tr.net) return { error: netFail(tr, base + '/git/trees/…', true) };
    if (!tr.ok) return { error: fail('读文件列表失败（HTTP ' + tr.status + '）', detail(tr)) };

    const files = new Map();
    for (const e of tr.data?.tree || []) {
      if (e.type !== 'blob' || !isManaged(e.path)) continue;
      files.set(e.path, e.sha);
    }
    return { empty: false, head, tree: treeSha, files, truncated: !!tr.data?.truncated };
  }

  /* ---- 比对 ---- */

  function diffOf(local, remote) {
    const d = { same: [], local: [], remote: [], both: [] };
    for (const [p, f] of local) {
      if (!remote.has(p)) d.local.push(p);
      else if (remote.get(p) === f.sha) d.same.push(p);
      else d.both.push(p);
    }
    for (const p of remote.keys()) if (!local.has(p)) d.remote.push(p);
    const byName = (a, b) => a.localeCompare(b, 'zh');
    d.same.sort(byName); d.local.sort(byName); d.remote.sort(byName); d.both.sort(byName);
    return d;
  }

  async function compare() {
    const bind = cur;
    if (!bind) return { error: fail('还没绑定仓库', '先填上面的字段并点「校验并绑定」') };
    const vault = window.StarNotes?.vault?.();
    if (!vault) return { error: fail('还没打开笔记库', '同步是「这个文件夹 ↔ 这个仓库」，先在顶栏选一个文件夹') };

    await window.StarNotes.flushWrites?.();    // 内存里的坐标先落盘，否则比的是旧文件
    const local = await collectLocal(vault);
    const st = await remoteState(bind);
    if (st.error) return { error: st.error };
    return { local, st, diff: diffOf(local, st.files), firstTime: !bind.syncedAt };
  }

  /* ---- 推送 ---- */

  async function doPush(res, opts, onProg) {
    const bind = cur;
    const { local, st, diff } = res;
    const upload = diff.local.concat(diff.both);
    const remove = opts && opts.keepRemote ? [] : diff.remote.slice();
    if (!upload.length && !remove.length) return { ok: true, nothing: true };

    const base = '/repos/' + bind.owner + '/' + bind.repo;
    const token = bind.token;

    // 1. 每个改动文件 → 一个 blob（内容寻址，重复的不会多存）
    const sha = new Map();
    let done = 0;
    await pool(upload, CONCURRENCY, async (p) => {
      const r = await api(base + '/git/blobs', token, {
        method: 'POST', body: { content: local.get(p).text, encoding: 'utf-8' },
      });
      if (r.net) boom(netFail(r, '/git/blobs'));
      if (!r.ok) boom(writeFail('上传「' + p + '」', r));
      sha.set(p, r.data.sha);
      done++;
      if (onProg) onProg(done, upload.length);
    });

    // 2. 用 base_tree 做增量：只列改动；没列到的原样保留，sha:null 表示删除
    const entries = upload.map((p) => ({ path: p, ...ENTRY, sha: sha.get(p) }))
      .concat(remove.map((p) => ({ path: p, ...ENTRY, sha: null })));
    const treeBody = { tree: entries };
    if (st.tree) treeBody.base_tree = st.tree;

    const tr = await api(base + '/git/trees', token, { method: 'POST', body: treeBody });
    if (tr.net) boom(netFail(tr, '/git/trees'));
    if (!tr.ok) boom(writeFail('提交目录树', tr));

    // 3. 提交。说明由界面传进来（可手改）；没传就退回按改动量拼一条
    const tags = [];
    if (diff.local.length) tags.push('+' + diff.local.length);
    if (diff.both.length) tags.push('~' + diff.both.length);
    if (remove.length) tags.push('-' + remove.length);
    const message = String((opts && opts.message) || '').trim() ||
      ('StarNotes: 同步笔记（' + (tags.join(' ') || '无改动') + '）');
    const who = { name: bind.author, email: bind.email, date: new Date().toISOString() };
    const cm = await api(base + '/git/commits', token, {
      method: 'POST',
      body: {
        message,
        tree: tr.data.sha,
        parents: st.head ? [st.head] : [],
        author: who,
        committer: who,
      },
    });
    if (cm.net) boom(netFail(cm, '/git/commits'));
    if (!cm.ok) boom(writeFail('创建提交', cm));

    // 4. 移动分支指针。force:false → 这期间别人推过就 409，让我们重来一遍
    if (st.head) {
      const rf = await api(base + '/git/refs/heads/' + branchPath(bind.branch), token, {
        method: 'PATCH', body: { sha: cm.data.sha, force: false },
      });
      if (rf.net) boom(netFail(rf, '/git/refs/heads/' + bind.branch, true));
      if (rf.status === 409 || rf.status === 422) {
        boom(fail('远端刚有了新提交', '别人（或你另一台机器）在这几秒里推过东西，点「比对」重来一次就行'));
      }
      if (!rf.ok) boom(writeFail('更新分支', rf));
    } else {
      // 空仓库：分支还不存在，不能 PATCH，只能建
      const rf = await api(base + '/git/refs', token, {
        method: 'POST', body: { ref: 'refs/heads/' + bind.branch, sha: cm.data.sha },
      });
      if (rf.net) boom(netFail(rf, '/git/refs', true));
      if (!rf.ok) boom(writeFail('创建分支', rf));
    }

    bind.syncedAt = Date.now();
    bind.syncedCommit = cm.data.sha;
    bind.empty = false;
    // 推送完，本地和远端又对齐了：之前「回退到某一版」的标记可以撤了
    bind.restoredCommit = null;
    bind.restoredAt = 0;
    await saveBind(bind);
    return { ok: true, commit: cm.data.sha, added: upload.length, removed: remove.length };
  }

  /* ---- 拉取 ---- */

  async function doPull(res, onProg) {
    const bind = cur;
    const { local, st, diff } = res;
    const need = diff.remote.concat(diff.both);
    const gone = diff.local;
    if (!need.length && !gone.length) return { ok: true, nothing: true };
    if (!st.head) return { ok: false, error: fail('仓库里还没有东西', '这个分支上还没有提交，先推送一次') };

    /* 拉取是唯一会覆盖本地内容的动作，而本地没有 .git 兜底。
       所以动手之前先把当前内容整份存进 IndexedDB。 */
    await saveSnap(local, st.head);

    const base = '/repos/' + bind.owner + '/' + bind.repo;
    const token = bind.token;
    const vault = window.StarNotes.vault();
    let done = 0;

    await pool(need, CONCURRENCY, async (p) => {
      const r = await api(base + '/git/blobs/' + st.files.get(p), token);
      if (r.net) boom(netFail(r, '/git/blobs/' + p));
      if (!r.ok) boom(fail('下载「' + p + '」失败（HTTP ' + r.status + '）', detail(r)));
      const text = normEol(fromBase64(r.data?.content));
      const { dir, name } = await ensureDir(vault, p);
      await writeTextTo(dir, name, text);
      done++;
      if (onProg) onProg(done, need.length);
    });

    let removed = 0;
    for (const p of gone) if (await removeLocal(vault, p)) removed++;
    if (removed) await pruneEmptyDirs(vault, gone);

    bind.syncedAt = Date.now();
    bind.syncedCommit = st.head;
    bind.restoredCommit = null;
    bind.restoredAt = 0;
    await saveBind(bind);
    return { ok: true, added: need.length, removed, commit: st.head };
  }

  /* ---- 历史版本 ----
     两个动作要分清楚：
     · 读历史 = GET /commits，只读，一个请求一页；
     · 回退 = 把**本地**变成某一版的样子，远端分支指针一动不动。
       想让 GitHub 也回到那一版，回退之后点推送 —— 那会生成一个新提交，
       历史一条都不会少。真正的「抹掉提交」要用 force push，这里不做，
       因为一次手滑就再也找不回来了。 */

  const HIST_PAGE = 20;

  async function listCommits(bind, page) {
    const base = '/repos/' + bind.owner + '/' + bind.repo;
    const p = base + '/commits?sha=' + encodeURIComponent(bind.branch) +
      '&per_page=' + HIST_PAGE + '&page=' + (page || 1);
    const r = await api(p, bind.token);
    if (r.net) return { error: netFail(r, p) };
    if (r.status === 401) return { error: fail('Token 被拒绝了（401）', '重新生成一个再绑定一次') };
    if (r.status === 409) return { list: [], more: false };   // 空仓库：GitHub 直接回 409
    if (r.status === 404) {
      return { error: fail('读不到「' + bind.branch + '」上的提交', '分支名对不对？仓库里还没提交过也会这样') };
    }
    if (!r.ok) return { error: fail('读提交历史失败（HTTP ' + r.status + '）', detail(r)) };

    const arr = Array.isArray(r.data) ? r.data : [];
    const list = arr.map((c) => {
      const full = String(c.commit?.message || '');
      const cut = full.indexOf('\n');
      return {
        sha: String(c.sha || ''),
        msg: (cut >= 0 ? full.slice(0, cut) : full).trim() || '(没有说明)',
        note: cut >= 0 ? full.slice(cut + 1).trim() : '',
        name: String(c.commit?.author?.name || c.author?.login || ''),
        date: c.commit?.author?.date || c.committer?.date || '',
        /* 改名前的提交是 `StarNote:`，改名后是 `StarNotes:`，两种都算「这台机器推的」 */
        mine: /^StarNotes?[:：]/.test(full),
        parents: (Array.isArray(c.parents) ? c.parents : []).map((x) => String(x.sha || '')),
      };
    });
    return { list, more: arr.length >= HIST_PAGE };
  }

  /* 某一版仓库里有哪些 .md。返回结构和 remoteState 一致，好复用 diffOf */
  async function stateAt(bind, sha) {
    const base = '/repos/' + bind.owner + '/' + bind.repo;
    const cmPath = base + '/git/commits/' + sha;
    const cm = await api(cmPath, bind.token);
    if (cm.net) return { error: netFail(cm, cmPath) };
    if (!cm.ok) return { error: fail('读这一版的目录失败（HTTP ' + cm.status + '）', detail(cm)) };

    const treeSha = cm.data?.tree?.sha;
    const tr = await api(base + '/git/trees/' + treeSha + '?recursive=1', bind.token);
    if (tr.net) return { error: netFail(tr, base + '/git/trees/…', true) };
    if (!tr.ok) return { error: fail('读这一版的文件列表失败（HTTP ' + tr.status + '）', detail(tr)) };

    const files = new Map();
    for (const e of tr.data?.tree || []) {
      if (e.type !== 'blob' || !isManaged(e.path)) continue;
      files.set(e.path, e.sha);
    }
    return { head: sha, tree: treeSha, files, truncated: !!tr.data?.truncated };
  }

  async function doRestore(sel, opts, onProg) {
    const bind = cur;
    const vault = window.StarNotes?.vault?.();
    if (!bind) return { ok: false, error: fail('还没绑定仓库', '') };
    if (!vault) return { ok: false, error: fail('还没打开笔记库', '') };

    const local = await collectLocal(vault);
    const diff = diffOf(local, sel.files);
    const need = diff.remote.concat(diff.both);
    const gone = opts && opts.keepLocal ? [] : diff.local;
    if (!need.length && !gone.length) return { ok: true, nothing: true };

    /* 和拉取一样：这是会覆盖本地内容的动作，本地没有 .git 兜底，先存一份 */
    await saveSnap(local, bind.syncedCommit || null);

    const base = '/repos/' + bind.owner + '/' + bind.repo;
    let done = 0;
    await pool(need, CONCURRENCY, async (p) => {
      const r = await api(base + '/git/blobs/' + sel.files.get(p), bind.token);
      if (r.net) boom(netFail(r, '/git/blobs/' + p));
      if (!r.ok) boom(fail('下载「' + p + '」失败（HTTP ' + r.status + '）', detail(r)));
      const text = normEol(fromBase64(r.data?.content));
      const { dir, name } = await ensureDir(vault, p);
      await writeTextTo(dir, name, text);
      done++;
      if (onProg) onProg(done, need.length);
    });

    let removed = 0;
    for (const p of gone) if (await removeLocal(vault, p)) removed++;
    if (removed) await pruneEmptyDirs(vault, gone);

    bind.restoredAt = Date.now();
    bind.restoredCommit = sel.sha;
    await saveBind(bind);
    return { ok: true, wrote: need.length, removed, commit: sel.sha, wentBack: need.length + removed };
  }

  /* ---- 拉取前的快照（也是唯一的「撤销」） ---- */

  let memSnaps = [];
  let snapAt = 0;

  async function loadSnaps() {
    try {
      const v = await store('get', (s) => s.get(SYNC_KEY), SNAP);
      memSnaps = Array.isArray(v) ? v : [];
    } catch (e) { /* IndexedDB 不可用时退回内存 */ }
    return memSnaps;
  }

  async function saveSnap(local, commit) {
    const snap = { at: Date.now(), commit: commit || null, files: [...local].map(([p, f]) => [p, f.text]) };
    const all = await loadSnaps();
    all.unshift(snap);
    memSnaps = all.slice(0, 3);
    snapAt = memSnaps.length ? memSnaps[0].at : 0;
    try { await store('put', (s) => s.put(memSnaps, SYNC_KEY), SNAP); } catch (e) { /* 只在本次会话有效 */ }
    return snap;
  }

  async function doUndo() {
    const vault = window.StarNotes?.vault?.();
    if (!vault) return { ok: false, error: fail('还没打开笔记库', '') };
    const snaps = await loadSnaps();
    if (!snaps.length) return { ok: false, error: fail('没有可恢复的快照', '只有「拉取」和「回退」会留快照；推送不会覆盖本地，所以不需要') };

    const snap = snaps[0];
    const now = await collectLocal(vault);
    const want = new Map(snap.files);

    // 把当前状态也存一份：恢复错了还能再点回来（这个按钮其实是双向的）
    await saveSnap(now, snap.commit);

    let wrote = 0, removed = 0;
    for (const [p, text] of want) {
      const have = now.get(p);
      if (have && have.text === text) continue;
      const { dir, name } = await ensureDir(vault, p);
      await writeTextTo(dir, name, text);
      wrote++;
    }
    for (const p of now.keys()) {
      if (want.has(p)) continue;
      if (await removeLocal(vault, p)) removed++;
    }
    if (removed) await pruneEmptyDirs(vault, [...now.keys()]);
    // 恢复到哪一版已经说不清了（快照可能是回退前后的任意一边），标记撤掉
    cur.restoredCommit = null;
    cur.restoredAt = 0;
    await saveBind(cur);
    return { ok: true, wrote, removed, at: snap.at };
  }

  /* ---------------- UI ---------------- */

  const DAY = 864e5;

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  const daysLeft = (ts) => Math.max(0, Math.ceil((ts - Date.now()) / DAY));

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return fmtDate(ts) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 四种状态，决定顶栏按钮长什么样：
       none     没绑
       ok       能用
       soon     7 天内到期（黄）
       expired  本地时间已过到期日，或 401 且到期日已过（红）
       invalid  401 但还没到到期日 → 被删/被重置（红）             */
  const WARN_DAYS = 7;

  function stateOf(b) {
    if (!b) return 'none';
    if (b.expiresAt && b.expiresAt <= Date.now()) return 'expired';
    if (b.stale) return b.staleReason === 'expired' ? 'expired' : 'invalid';
    if (b.expiresAt && b.expiresAt - Date.now() <= WARN_DAYS * DAY) return 'soon';
    return 'ok';
  }

  /* 一次免费请求就能知道 token 还活着吗、什么时候到期：
     /rate_limit 不消耗配额，而任何已认证响应都带到期头。
     后台检查不重试，免得静默等上几十秒。 */
  async function probe(token) {
    const r = await once('/rate_limit', token, TIMEOUT);
    if (r.net) return { kind: 'net' };
    if (r.status === 401) return { kind: 'dead' };
    if (r.status === 403) return { kind: 'denied' };
    if (!r.ok) return { kind: 'other', status: r.status };
    return { kind: 'ok', expiresAt: r.expiry || null };
  }

  /* 打开网页时静默查一次（每 6 小时最多一次）。网络问题不冤枉 token。 */
  async function watch(force) {
    const b = cur;
    if (!b || !b.token || probing) return;
    if (!force && b.checkedAt && Date.now() - b.checkedAt < 6 * 3600e3) return;

    probing = true;
    const was = stateOf(b);
    const r = await probe(b.token);
    probing = false;
    if (cur !== b) return;            // 中途解绑或换了绑定，别把旧结果写回去
    if (r.kind === 'net' || r.kind === 'denied' || r.kind === 'other') return;

    if (r.kind === 'dead') {
      b.stale = true;
      b.staleReason = b.expiresAt && b.expiresAt <= Date.now() ? 'expired' : 'invalid';
    } else {
      b.stale = false;
      b.staleReason = null;
      if (r.expiresAt) b.expiresAt = r.expiresAt;
    }
    b.checkedAt = Date.now();
    await saveBind(b);
    renderBtn(b);

    const now = stateOf(b);
    if (!$('#ghMask').hidden && !busy) showCur();
    if (now !== was && (now === 'expired' || now === 'invalid') && !noticed) {
      noticed = true;
      say('GitHub Token ' + (now === 'expired' ? '已过期' : '已失效') + '，点顶栏更新');
    }
  }

  /* 面板打开时按当前绑定状态显示一句话（有结果时由 onSubmit 接管） */
  function showCur() {
    const st = stateOf(cur);
    if (!cur) { clearStatus(); return; }
    if (st === 'expired') {
      status('bad', 'Token 已于 ' + fmtDate(cur.expiresAt) + ' 过期',
        '去 GitHub 重新生成一个粘到下面，其他字段不用改，然后点「校验并绑定」');
      return;
    }
    if (st === 'invalid') {
      status('bad', 'Token 已失效（被删除或被重置）',
        '重新生成一个粘到下面，其他字段不用改，然后点「校验并绑定」');
      return;
    }
    if (st === 'soon') {
      status('warn', 'Token 还有 ' + daysLeft(cur.expiresAt) + ' 天到期（' + fmtDate(cur.expiresAt) + '）',
        '现在换一个最省事；过期后再换也不丢东西，只是同步会先失败一次');
      return;
    }
    if (cur.branchUnchecked) {
      status('warn', '上次没能确认分支「' + cur.branch + '」（网络超时）',
        '不影响绑定，推送时会再确认一次；网络好了点「校验并绑定」可以补上');
      return;
    }
    clearStatus();
  }

  const maskToken = (t) => {
    const s = String(t || '');
    if (s.length <= 10) return '****';
    return s.slice(0, 10) + '…' + s.slice(-4);
  };

  function renderBtn(bind) {
    const b = $('#btnGH');
    if (!b) return;
    const st = stateOf(bind);
    b.classList.toggle('bound', !!bind);
    b.classList.toggle('warn', st === 'soon');
    b.classList.toggle('stale', st === 'expired' || st === 'invalid');

    const name = b.querySelector('.gh-name');
    if (!bind) {
      name.textContent = 'GitHub';
      b.title = '绑定 GitHub 仓库';
      return;
    }
    const repo = bind.owner + '/' + bind.repo;
    if (st === 'expired') {
      name.textContent = 'Token 已过期';
      b.title = repo + ' · Token 已于 ' + fmtDate(bind.expiresAt) + ' 过期，点击更新';
    } else if (st === 'invalid') {
      name.textContent = 'Token 已失效';
      b.title = repo + ' · Token 被删除或重置，点击更新';
    } else {
      name.textContent = repo;
      b.title = '已绑定 ' + repo + ' @ ' + bind.branch +
        (bind.branchUnchecked ? ' · 分支未确认' : '') +
        (bind.readonly ? ' · Token 只读，不能推送' : '') +
        (bind.expiresAt
          ? ' · Token ' + fmtDate(bind.expiresAt) + ' 到期' + (st === 'soon' ? '（还有 ' + daysLeft(bind.expiresAt) + ' 天）' : '')
          : '') +
        '（点击修改或解绑）';
    }
  }

  /* ---------------- 同步面板 ---------------- */

  let syncing = false;
  let syncState = null;     // 上一次比对的结果，推送 / 拉取都基于它

  const tail = (p) => String(p).split('/').pop();

  function listOf(arr, n) {
    const k = n || 3;
    const head = arr.slice(0, k).map(tail).join('、');
    return esc(head) + (arr.length > k ? ' 等 ' + arr.length + ' 个' : '');
  }

  function syncRow(kind, label, files, hint) {
    return '<div class="gs-row"><span class="gs-tag ' + kind + '">' + esc(label) + '</span>' +
      '<span class="gs-files">' + listOf(files) +
      '<span class="gs-hint">' + esc(hint) + '</span></span></div>';
  }

  function renderSync(res) {
    const box = $('#ghSync');
    if (!box || !$('#gsWho')) return;
    box.hidden = !cur;
    if (!cur) { hist.open = false; renderHistory(); return; }

    const who = $('#gsWho'), diff = $('#gsDiff'), push = $('#gsPush'), pull = $('#gsPull');
    const keepRow = $('#gsKeepRow'), undo = $('#gsUndo');
    if (keepRow) keepRow.hidden = true;
    if (undo) undo.hidden = !snapAt;

    if (!window.StarNotes?.vault?.()) {
      who.textContent = '还没打开笔记库';
      diff.innerHTML = '<div class="gs-empty">同步是「这个文件夹 ↔ 这个仓库」，先在顶栏选一个文件夹。</div>';
      push.disabled = true; pull.disabled = true; syncState = null;
      hideMsg();
      return;
    }
    if (!res) {
      who.textContent = '正在比对…';
      diff.innerHTML = '';
      push.disabled = true; pull.disabled = true;
      hideMsg();
      return;
    }
    if (res.error) {
      who.textContent = '比对失败';
      diff.innerHTML = '<div class="gs-err">' + esc(res.error.reason || '') +
        (res.error.hint ? '<span>' + esc(res.error.hint) + '</span>' : '') + '</div>';
      push.disabled = true; pull.disabled = true; syncState = null;
      hideMsg();
      return;
    }

    const d = res.diff;
    const dirty = d.local.length + d.remote.length + d.both.length;
    who.textContent = '本地 ' + res.local.size + ' 篇 · 远端 ' + res.st.files.size + ' 篇 · ' +
      (dirty ? dirty + ' 处不同' : '一致') + (res.st.empty ? '（仓库还空着）' : '');

    const rows = [];
    if (d.local.length) rows.push(syncRow('up', '只在本地', d.local, '推送上传 · 拉取会删掉'));
    if (d.remote.length) rows.push(syncRow('down', '只在远端', d.remote, '拉取下载 · 推送会删掉'));
    if (d.both.length) rows.push(syncRow('both', '内容不同', d.both, '谁覆盖谁，看你点哪个'));
    diff.innerHTML = rows.length ? rows.join('') : '<div class="gs-empty">两边一模一样，不用动。</div>';

    /* token 只读：读方向照常，推送这条路是死的。按钮关掉，并在差异表最上面
       说明原因 —— 让人点一次、吃一次 403 是没有意义的 */
    const ro = cur.readonly === true;
    if (ro) {
      who.textContent += ' · token 只读';
      diff.innerHTML = '<div class="gs-ro">这个 Token 只能读，推送会被拒。' +
        '去 token 设置里把 Contents 改成 Read and write（classic 是勾 repo），保存后点这里右上角的「比对」重测，' +
        '不用重新填表单。</div>' + diff.innerHTML;
    }
    /* 回退过之后，本地和远端是有意不一致的，得说清楚「谁还没跟上」，
       否则差异表看起来像出了故障 */
    if (cur.restoredCommit && res.st.head && cur.restoredCommit !== res.st.head) {
      diff.innerHTML = '<div class="gs-ro">本地已回退到 ' + esc(shortSha(cur.restoredCommit)) +
        ' 那一版，远端最新还是 ' + esc(shortSha(res.st.head)) +
        '。要让 GitHub 也回到这一版，点「推送 →」—— 会生成一个新提交，历史一条都不会少。</div>' + diff.innerHTML;
    }
    push.disabled = ro || !dirty;
    pull.disabled = !dirty;

    /* 有东西要推才显示说明框；只读时推送这条路本来就死，也不显示。
       手改过就不覆盖 —— 人写了一半被「比对」冲掉是最恼人的那种 bug */
    const msgRow = $('#gsMsgRow');
    if (msgRow) msgRow.hidden = ro || !dirty;
    if (!msgDirty) setMsg(autoMsg(d));
    paintMsgTip();
    if (res.firstTime && d.remote.length) {
      keepRow.hidden = false;
      $('#gsKeepText').textContent = '首次推送：保留远端这 ' + d.remote.length + ' 个文件（不删）';
    }
    syncState = res;
  }

  /* ---- 历史面板 ---- */

  const shortSha = (s) => String(s || '').slice(0, 7);

  function fmtCommitTime(iso) {
    const d = new Date(iso);
    if (!d || isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    const ymd = d.getFullYear() === new Date().getFullYear()
      ? p(d.getMonth() + 1) + '-' + p(d.getDate())
      : d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return ymd + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  let hist = { open: false, list: [], page: 1, more: false, loading: false, err: null, pick: null, head: null, busy: false };

  function histSummary() {
    const p = hist.pick;
    if (!p) return '选一版，看它和现在的差别';
    if (!p.diff) return '正在读这一版…';
    const d = p.diff;
    const bits = [];
    if (d.remote.length) bits.push('新增 ' + d.remote.length);
    if (d.local.length) bits.push('本地多出 ' + d.local.length);
    if (d.both.length) bits.push('改写 ' + d.both.length);
    if (!bits.length && d.same.length) return '和现在一样（' + d.same.length + ' 篇）';
    return bits.join(' · ') || '空仓库';
  }

  function renderHistory() {
    const box = $('#gsHist');
    if (!box) return;
    box.hidden = !(cur && hist.open);
    const btn = $('#gsHistory');
    if (btn) btn.classList.toggle('on', !!hist.open);
    const br = $('#gsHistBr');
    if (br) br.textContent = cur ? cur.branch : '';
    if (box.hidden) return;

    const list = $('#gsHistList');
    if (hist.loading) {
      list.innerHTML = '<div class="gs-empty">正在读提交历史…</div>';
    } else if (hist.err) {
      list.innerHTML = '<div class="gs-err">' + esc(hist.err.reason || '') +
        (hist.err.hint ? '<span>' + esc(hist.err.hint) + '</span>' : '') + '</div>';
    } else if (!hist.list.length) {
      list.innerHTML = '<div class="gs-empty">这个分支还没有提交。第一次推送之后，就能在这里选一版回退。</div>';
    } else {
      list.innerHTML = hist.list.map((c, i) => {
        const on = hist.pick && hist.pick.sha === c.sha;
        const tag = c.sha === hist.head
          ? '<span class="gs-c-tag head">远端最新</span>'
          : (c.mine ? '<span class="gs-c-tag mine">StarNotes</span>' : '');
        return '<div class="gs-commit' + (on ? ' on' : '') + '" data-i="' + i + '" title="' +
          esc(c.note || c.msg) + '">' +
          '<span class="gs-c-dot"></span>' +
          '<div><div class="gs-c-msg">' + esc(c.msg) + '</div>' +
          '<div class="gs-c-meta">' + esc(shortSha(c.sha)) + ' · ' + esc(fmtCommitTime(c.date)) +
          (c.name ? ' · ' + esc(c.name) : '') + '</div></div>' +
          tag + '</div>';
      }).join('') +
        (hist.more ? '<button class="gs-more" id="gsHistMore">加载更早的 ' + HIST_PAGE + ' 条</button>' : '');
    }

    const sel = $('#gsHistSel');
    if (sel) sel.textContent = histSummary();
    const rs = $('#gsRestore');
    if (rs) rs.disabled = syncing || hist.busy || !hist.pick || !hist.pick.files;
    const delRow = $('#gsHistDelRow');
    if (delRow) delRow.hidden = !hist.pick || !hist.pick.diff || !hist.pick.diff.local.length;
  }

  /* 每次打开都重读一次：一个请求，换「刚推完就能看见新提交」 */
  function toggleHistory() {
    keepOpen();
    if (!cur) return;
    if (hist.open) { hist.open = false; renderHistory(); return; }
    loadHistory(1);
  }

  async function loadHistory(page) {
    if (!cur) return;
    hist.open = true;
    hist.loading = true;
    hist.err = null;
    if (page === 1) { hist.list = []; hist.pick = null; }
    renderHistory();

    let r;
    try { r = await listCommits(cur, page); }
    catch (e) { r = { error: fail('读提交历史时出错了：' + e.message, '点「刷新」再试一次') }; }
    hist.loading = false;
    if (r.error) { hist.err = r.error; renderHistory(); return; }

    hist.list = page === 1 ? r.list : hist.list.concat(r.list);
    hist.page = page;
    hist.more = r.more;
    /* 「远端最新」以比对时抓到的 head 为准；没比对过就退回列表第一条
       （GitHub 的 /commits 默认就是从新到旧） */
    hist.head = (syncState && syncState.st && syncState.st.head) || (r.list[0] && r.list[0].sha) || null;
    renderHistory();
  }

  async function pickCommit(c) {
    if (!c || hist.busy || !cur) return;
    keepOpen();
    hist.pick = { sha: c.sha, item: c, files: null, diff: null };
    hist.busy = true;
    renderHistory();

    const st = await stateAt(cur, c.sha);
    if (st.error) {
      hist.busy = false; hist.pick = null; renderHistory();
      status('bad', st.error.reason, st.error.hint);
      return;
    }
    const vault = window.StarNotes?.vault?.();
    if (!vault) { hist.busy = false; renderHistory(); return; }
    await window.StarNotes.flushWrites?.();
    const local = await collectLocal(vault);
    hist.busy = false;
    if (!hist.pick || hist.pick.sha !== c.sha) return;   // 期间点了别的行
    hist.pick.files = st.files;
    hist.pick.diff = diffOf(local, st.files);
    renderHistory();
  }

  async function onRestore() {
    keepOpen();
    const p = hist.pick;
    if (!p || !p.files || syncing) return;
    const d = p.diff;
    const keepLocal = !$('#gsHistDel').checked;
    const need = d.remote.length + d.both.length;
    const del = keepLocal ? [] : d.local;
    if (!need && !del.length) { status('warn', '本地已经是这一版了', '没有要改的东西'); return; }

    const lines = ['把本地回退到 ' + shortSha(p.sha) + ' 这一版。'];
    if (need) lines.push('· 写回 ' + need + ' 篇（新增 ' + d.remote.length + ' · 改写 ' + d.both.length + '）');
    if (del.length) {
      lines.push('· 删掉 ' + del.length + ' 个这一版里没有的：' +
        del.slice(0, 6).join('、') + (del.length > 6 ? ' …' : ''));
    } else if (d.local.length) {
      lines.push('· 这一版里没有的 ' + d.local.length + ' 个保留不动');
    }
    lines.push('', '远端分支不会动。要让 GitHub 也回到这一版，回退后点「推送 →」。');
    lines.push('本地现在的内容会存一份快照，点「恢复上一版」可以切回来。');
    lines.push('', '确定回退？');
    if (!confirm(lines.join('\n'))) return;

    syncing = true;
    setSyncBusy(true);
    status('run', '正在回退', need ? '写回 0/' + need : '清理这一版里没有的文件');
    let r;
    try {
      r = await doRestore(p, { keepLocal }, (i, n) => status('run', '正在回退', '写回 ' + i + '/' + n));
    } catch (e) {
      r = { ok: false, error: (e && e.fail) || fail('回退时出错了：' + e.message, '点「比对」再试一次') };
    }
    syncing = false;
    setSyncBusy(false);

    if (!r.ok) { status('bad', r.error.reason, r.error.hint); return; }
    if (r.nothing) { status('warn', '本地已经是这一版了', '没有要改的东西'); return; }

    status('good', '已回退到 ' + shortSha(p.sha),
      '写回 ' + r.wrote + ' 篇' + (r.removed ? ' · 删掉 ' + r.removed + ' 个' : '') +
      ' · 远端未动，点「推送 →」才会同步过去');
    say('已回退到 ' + shortSha(p.sha));
    await window.StarNotes.reloadLevel?.({ discard: true });
    hist.pick = null;
    await refresh();
    renderHistory();
  }

  /* 写权限是多变的：可能上一版建绑定时没测过（那时还没有这一步），也可能
     人刚在 GitHub 上把 Contents 改成 Read and write。所以只在**确认可写**之后
     才停止追问；只读和未知都值得再问一次 —— 代价是一个请求，换来「改完权限
     点一下「比对」就通」的体验。 */
  async function ensureWrite() {
    if (!cur || cur.readonly === false) return;
    const b = cur;
    const wp = await writeProbe('/repos/' + b.owner + '/' + b.repo, b.token);
    if (!wp.known) return;         // 网络/限流：问不出来不等于只读，留到下次
    b.readonly = wp.readonly;
    await saveBind(b);
    if (cur === b) renderBtn(b);
  }

  async function refresh() {
    if (!cur || syncing) return null;
    keepOpen();
    syncing = true;
    await loadSnaps();
    if (boxVisible()) renderSync(null);
    let r;
    try { r = await compare(); }
    catch (e) { r = { error: fail('比对时出错了：' + e.message, '点「比对」再试一次') }; }
    if (r && !r.error) await ensureWrite();
    syncing = false;
    renderSync(r);
    /* 历史面板开着时，「远端最新」这个标记要跟着新 head 走，
       否则推完一次还指着旧的 */
    if (hist.open) {
      if (r && !r.error && r.st) hist.head = r.st.head || hist.head;
      renderHistory();
    }
    return r;
  }

  const boxVisible = () => !!$('#ghMask') && !$('#ghMask').hidden;

  function setSyncBusy(on) {
    ['#gsPush', '#gsPull', '#gsRefresh', '#gsUndo', '#gsHistory', '#gsHistReload', '#gsRestore'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = on;
    });
    if (on) return;
    if (syncState) renderSync(syncState);
    else { const u = $('#gsUndo'); if (u) u.hidden = !snapAt; }
    // 空闲下来按「选中了哪一版」重新决定回退按钮能不能点，别一律放开
    const rs = $('#gsRestore');
    if (rs) rs.disabled = !hist.pick || !hist.pick.files || hist.busy;
  }

  /* ---- 提交信息 ----
     默认按这次改动自动写一条，推之前可以改。改过就不再被自动覆盖，
     否则每点一次「比对」手写的那句就没了。 */

  let msgDirty = false;

  function hideMsg() {
    const row = $('#gsMsgRow');
    if (row) row.hidden = true;
  }

  function autoMsg(d) {
    const tags = [];
    if (d.local.length) tags.push('+' + d.local.length);
    if (d.both.length) tags.push('~' + d.both.length);
    if (d.remote.length) tags.push('-' + d.remote.length);
    const head = 'StarNotes: 同步笔记（' + (tags.join(' ') || '无改动') + '）';

    const lines = [];
    const add = (label, arr) => {
      if (!arr.length) return;
      lines.push('· ' + label + ' ' + arr.slice(0, 12).join('、') +
        (arr.length > 12 ? ' 等 ' + arr.length + ' 篇' : ''));
    };
    add('新增', d.local);
    add('修改', d.both);
    add('删除', d.remote);
    return lines.length ? head + '\n\n' + lines.join('\n') : head;
  }

  function paintMsgTip() {
    const tip = $('#gsMsgTip');
    if (!tip) return;
    tip.textContent = msgDirty ? '已手改' : '自动';
    tip.classList.toggle('manual', msgDirty);
  }

  function setMsg(text) {
    const ta = $('#gsMsg');
    if (!ta) return;
    ta.value = text;
  }

  const currentMsg = () => ($('#gsMsg')?.value || '').trim();

  async function onPush() {
    keepOpen();
    const res = syncState;
    if (!res || !res.diff || syncing) return;
    const d = res.diff;
    const keepRemote = !$('#gsKeepRow').hidden && $('#gsKeep').checked;
    const up = d.local.length + d.both.length;
    const del = keepRemote ? 0 : d.remote.length;
    if (!up && !del) { status('warn', '两边已经一样了', '没有要推的东西'); return; }

    // 清空了也用，不然 GitHub 那边会是一条空说明 —— 宁可退回自动生成的
    const message = currentMsg() || autoMsg(d);

    const lines = ['推送会用本地覆盖远端。'];
    if (up) lines.push('· 上传 ' + up + ' 篇');
    if (del) lines.push('· 删除远端 ' + del + ' 个：' + d.remote.slice(0, 6).join('、') + (del > 6 ? ' …' : ''));
    if (keepRemote && d.remote.length) lines.push('· 远端多出来的 ' + d.remote.length + ' 个保留不动');
    lines.push('', '提交信息：' + message.split('\n')[0]);
    lines.push('', '确定推送？');
    if (!confirm(lines.join('\n'))) return;

    syncing = true;
    setSyncBusy(true);
    status('run', '正在推送', up ? '上传 0/' + up : '删除远端多余的文件');
    let r;
    try {
      r = await doPush(res, { keepRemote, message }, (i, n) => status('run', '正在推送', '上传 ' + i + '/' + n));
    } catch (e) {
      r = { ok: false, error: (e && e.fail) || fail('推送时出错了：' + e.message, '点「比对」再试一次') };
    }
    syncing = false;
    setSyncBusy(false);

    if (!r.ok) { status('bad', r.error.reason, r.error.hint); return; }
    if (r.nothing) { status('warn', '没有要推的东西', '两边已经一样了'); return; }
    msgDirty = false;
    if (hist.open) { hist.list = []; }        // head 变了，历史下次重读
    status('good', '推送完成 · ' + String(r.commit || '').slice(0, 7),
      '上传 ' + r.added + ' 篇' + (r.removed ? ' · 删除远端 ' + r.removed + ' 个' : ''));
    say('已推送 ' + (r.added + r.removed) + ' 个改动到 GitHub');
    await refresh();
    if (hist.open) loadHistory(1);
  }

  async function onPull() {
    keepOpen();
    const res = syncState;
    if (!res || !res.diff || syncing) return;
    const d = res.diff;
    const down = d.remote.length + d.both.length;
    const del = d.local.length;
    if (!down && !del) { status('warn', '两边已经一样了', '没有要拉的东西'); return; }
    if (!res.st.head) { status('bad', '仓库里还没有东西', '这个分支上还没有提交，先推送一次'); return; }

    const lines = ['拉取会用远端覆盖本地。'];
    if (down) lines.push('· 下载 ' + down + ' 篇（本地同名的会被替换）');
    if (del) lines.push('· 删除本地 ' + del + ' 个：' + d.local.slice(0, 6).join('、') + (del > 6 ? ' …' : ''));
    lines.push('', '本地被覆盖的内容会存一份快照，可以点「恢复拉取前」。');
    if (!confirm(lines.join('\n'))) return;

    syncing = true;
    setSyncBusy(true);
    status('run', '正在拉取', '下载 0/' + down);
    let r;
    try {
      r = await doPull(res, (i, n) => status('run', '正在拉取', '下载 ' + i + '/' + n));
    } catch (e) {
      r = { ok: false, error: (e && e.fail) || fail('拉取时出错了：' + e.message, '点「比对」再试一次') };
    }
    syncing = false;
    setSyncBusy(false);

    if (!r.ok) { status('bad', r.error.reason, r.error.hint); return; }
    if (r.nothing) { status('warn', '没有要拉的东西', '两边已经一样了'); return; }
    status('good', '拉取完成',
      '下载 ' + r.added + ' 篇' + (r.removed ? ' · 删除本地 ' + r.removed + ' 个' : '') + ' · 可以「恢复拉取前」');
    say('已从 GitHub 拉取 ' + (r.added + r.removed) + ' 个改动');

    // 本地文件刚被覆盖，内存里的坐标和打开的编辑器都得丢掉
    await window.StarNotes.reloadLevel?.({ discard: true });
    await refresh();
    if (hist.open) loadHistory(1);
  }

  async function onUndo() {
    keepOpen();
    if (syncing) return;
    if (!confirm('把本地恢复成上一次覆盖之前的样子？\n（拉取和「回退到某一版」都会覆盖本地）\n当前内容也会存一份，点两次可以来回切。')) return;

    syncing = true;
    setSyncBusy(true);
    status('run', '正在恢复', '');
    let r;
    try { r = await doUndo(); }
    catch (e) { r = { ok: false, error: fail('恢复时出错了：' + e.message, '点「比对」再试一次') }; }
    syncing = false;
    setSyncBusy(false);

    if (!r.ok) { status('bad', r.error.reason, r.error.hint); return; }
    status('good', '已恢复到 ' + fmtTime(r.at),
      '写回 ' + r.wrote + ' 篇' + (r.removed ? ' · 删掉 ' + r.removed + ' 个' : ''));
    say('已恢复到上一次覆盖之前');
    hist.pick = null;
    await window.StarNotes.reloadLevel?.({ discard: true });
    await refresh();
    renderHistory();
  }

  function status(kind, title, sub) {
    const box = $('#ghStatus');
    if (!box) return;
    box.hidden = false;
    box.className = 'gh-status show ' + kind;
    box.innerHTML =
      '<span class="gh-ico"></span>' +
      '<span class="gh-msg"><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</span>';
  }

  function clearStatus() {
    const box = $('#ghStatus');
    if (!box) return;
    box.hidden = true;
    box.className = 'gh-status';
    box.textContent = '';
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readForm() {
    return {
      repo: $('#ghRepo').value.trim(),
      branch: $('#ghBranch').value.trim(),
      token: $('#ghToken').value,
      author: $('#ghName').value.trim(),
      email: $('#ghMail').value.trim(),
    };
  }

  function fillForm(bind) {
    $('#ghRepo').value = bind ? bind.owner + '/' + bind.repo : '';
    $('#ghBranch').value = bind ? bind.branch : 'main';
    $('#ghToken').value = bind ? bind.token : '';
    $('#ghName').value = bind ? bind.author : '';
    $('#ghMail').value = bind ? bind.email : '';
    $('#ghUnbind').hidden = !bind;
  }

  function open() {
    clearTimeout(closeTimer);
    fillForm(cur);
    renderBtn(cur);
    $('#ghMask').hidden = false;
    const st = stateOf(cur);
    showCur();
    renderSync(null);                 // 先占位，比对完再填内容
    // token 已经不可用时就别再去比了：一条注定 401 的请求，加一条重复的红字
    if (cur) {
      if (st === 'expired' || st === 'invalid') {
        renderSync({ error: fail('Token 不可用，换好新的再看差异', '') });
      } else {
        refresh();                    // 点开就顺手比一次，省得再点一下「比对」
      }
    }
    setTimeout(() => {
      // 过期/快过期就把人直接领到 Token 那一格，别让他找
      const target = st === 'expired' || st === 'invalid' || st === 'soon'
        ? $('#ghToken')
        : (!cur ? $('#ghRepo') : $('#ghToken'));
      target.focus();
      target.select?.();
    }, 30);
    watch(true);        // 顺手静默复查：刚过期的话，点开就看到真话
  }

  function close() {
    $('#ghMask').hidden = true;
    clearStatus();
  }

  function setBusy(on) {
    busy = on;
    const btn = $('#ghSubmit');
    btn.disabled = on;
    btn.textContent = on ? '校验中…' : '校验并绑定';
    $('#ghCancel').disabled = on;
    $('#ghUnbind').disabled = on;
  }

  const STEPS = { user: 'Token', repo: '仓库权限', write: '写权限', ref: '分支' };

  async function onSubmit() {
    if (busy) return;
    const cfg = readForm();
    const prev = cur;
    setBusy(true);

    // 进度条：几个请求分开显示，卡在哪一步一眼看得出来
    const keys = Object.keys(STEPS);
    const marks = {};
    keys.forEach((k) => { marks[k] = '·'; });
    const paint = () => keys.map((k) => STEPS[k] + ' ' + marks[k]).join('  ');
    status('run', '正在校验', paint());
    const onStep = (k, s) => {
      marks[k] = s === 'run' ? '…' : s === 'ok' ? '✓' : s === 'skip' ? '—' : '✗';
      status('run', '正在校验', paint());
    };

    let r;
    try { r = await verify(cfg, onStep); } catch (e) { r = fail('校验时出错了：' + e.message, '点「校验并绑定」再试一次'); }
    setBusy(false);

    if (!r.ok) { status('bad', r.reason, r.hint); return; }

    const bind = {
      owner: r.info.owner,
      repo: r.info.repo,
      branch: r.info.branch,
      token: cfg.token.trim(),
      author: cfg.author,
      email: cfg.email,
      login: r.info.login,
      commit: r.info.commit,
      empty: r.info.empty,
      branchUnchecked: !!r.info.branchUnchecked,
      readonly: r.info.readonly === true,
      expiresAt: r.info.expiresAt || null,
      checkedAt: Date.now(),
      stale: false,
      staleReason: null,
      at: Date.now(),
    };
    // 同一个仓库重新校验时，别把「上次同步到哪」弄丢，否则首次推送的保护
    // 会又弹一次（不算错，但会让人以为没同步过）
    if (prev && prev.owner === bind.owner && prev.repo === bind.repo && prev.branch === bind.branch) {
      bind.syncedAt = prev.syncedAt || 0;
      bind.syncedCommit = prev.syncedCommit || null;
    }
    await saveBind(bind);
    syncState = null;
    // 换了仓库/分支，旧的历史列表一条都不能留（照着它回退会写错库）
    hist = { open: false, list: [], page: 1, more: false, loading: false, err: null, pick: null, head: null, busy: false };
    msgDirty = false;
    setMsg('');
    renderHistory();
    noticed = false;
    renderBtn(bind);

    const bits = ['认证为 @' + (r.info.login || '未知账号'), 'token ' + maskToken(bind.token)];
    bits.push(r.info.empty ? '仓库还没有提交，第一次推送会自动建分支' : '当前提交 ' + String(r.info.commit || '').slice(0, 7));
    bits.push(bind.expiresAt ? 'Token ' + fmtDate(bind.expiresAt) + ' 到期' : 'Token 没有到期时间');
    const where = bind.owner + '/' + bind.repo + ' @ ' + bind.branch;

    if (r.info.readonly) {
      // 读是通的，所以照绑；但推送一定会 403，得现在就说清楚，并把按钮关掉
      status('warn', '已绑定 ' + where + '，但这个 Token 只能读',
        '推送会被 GitHub 拒（403 Resource not accessible）。去 token 设置里开写权限：' +
        'fine-grained → Contents 改成 Read and write，classic → 勾 repo。保存后点「校验并绑定」重试，' +
        'token 本身一般不用换。拉取不受影响，现在就能用。');
      say('已绑定 ' + where + '（只读 token）');
      refresh();                   // 同步区按「只读」重画一遍：按钮灰掉 + 顶部写明原因
      return;                      // 不自动收起，让人看见
    }

    if (r.soft) {
      // 分支那一步是网络问题，不是地址问题：先绑上，别让人今晚用不了
      status('warn', '已绑定 ' + where + '，但「' + bind.branch + '」分支没能确认',
        (r.soft.reason || '') + '。' + (r.soft.hint || '') + ' 推送时会再确认一次');
      say('已绑定 ' + where + '（分支待确认）');
      return;                      // 故意不自动收起，让人看见这条黄条
    }

    status('good', '绑定成功 · ' + where, bits.join(' · '));
    say('已绑定 ' + where);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (cur === bind && !busy) close(); }, 1100);
  }

  async function unbind() {
    if (!cur) return;
    const name = cur.owner + '/' + cur.repo;
    await clearBind();
    syncState = null;
    hist = { open: false, list: [], page: 1, more: false, loading: false, err: null, pick: null, head: null, busy: false };
    msgDirty = false;
    setMsg('');
    renderBtn(null);
    fillForm(null);
    renderSync(null);
    clearStatus();
    close();
    say('已解除绑定：' + name);
  }

  /* ---------------- 事件绑定 ---------------- */

  function boot() {
    if (!$('#btnGH')) return;

    $('#btnGH').addEventListener('click', open);
    $('#ghCancel').addEventListener('click', () => { if (!busy) close(); });
    $('#ghUnbind').addEventListener('click', unbind);
    $('#ghSubmit').addEventListener('click', onSubmit);
    $('#gsRefresh').addEventListener('click', () => refresh());
    $('#gsPush').addEventListener('click', onPush);
    $('#gsPull').addEventListener('click', onPull);
    $('#gsUndo').addEventListener('click', onUndo);

    // 提交信息：敲过就算手改，不再被自动生成的覆盖；「重写」恢复自动那条
    const msg = $('#gsMsg');
    if (msg) msg.addEventListener('input', () => { msgDirty = true; paintMsgTip(); });
    const gen = $('#gsMsgGen');
    if (gen) gen.addEventListener('click', () => {
      msgDirty = false;
      if (syncState && syncState.diff) setMsg(autoMsg(syncState.diff));
      paintMsgTip();
    });

    $('#gsHistory').addEventListener('click', toggleHistory);
    $('#gsHistReload').addEventListener('click', () => loadHistory(1));
    $('#gsHistClose').addEventListener('click', () => { hist.open = false; renderHistory(); });
    $('#gsRestore').addEventListener('click', onRestore);
    // 列表是每次重画的，逐个绑监听会漏，直接在容器上委托
    $('#gsHistList').addEventListener('click', (ev) => {
      const more = ev.target.closest && ev.target.closest('#gsHistMore');
      if (more) { loadHistory(hist.page + 1); return; }
      const row = ev.target.closest && ev.target.closest('.gs-commit');
      if (!row) return;
      const c = hist.list[Number(row.getAttribute('data-i'))];
      if (c) pickCommit(c);
    });

    $('#ghMask').addEventListener('pointerdown', (ev) => {
      if (ev.target === $('#ghMask') && !busy) close();
    });
    $('#ghMask').addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !busy) { ev.stopPropagation(); close(); return; }
      if (ev.key !== 'Enter') return;
      // 只要光标在文本框里回车就提交；勾选框上的回车不该触发校验
      const t = ev.target;
      if (t && t.tagName === 'INPUT' && t.type !== 'checkbox') { ev.preventDefault(); onSubmit(); }
    });

    // 改任何字段都把上一次的校验结果收掉，别让旧错误/旧成功留在屏幕上误导人
    for (const id of ['#ghRepo', '#ghBranch', '#ghToken', '#ghName', '#ghMail']) {
      $(id).addEventListener('input', clearStatus);
    }

    loadBind().then((b) => {
      renderBtn(b);
      if (b) watch(false);      // 打开网页先悄悄问一句「token 还活着吗」
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.GH = {
    open, close, verify, parseRepo, reload: loadBind, current: () => cur, unbind, maskToken,
    stateOf, watch, probe, parseExpiry, fmtDate, fmtTime, daysLeft,
    // 同步：给测试用的入口
    compare, refresh, doPush, doPull, doUndo, diffOf, blobSha, collectLocal, remoteState,
    isManaged, normEol, loadSnaps, state: () => syncState,
    // 历史版本
    listCommits, stateAt, doRestore, pickCommit, loadHistory, renderHistory,
    history: () => hist,
  };
})();
