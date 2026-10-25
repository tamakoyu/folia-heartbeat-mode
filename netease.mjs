// netease.mjs
// 心动模式的网易云后端访问：本地内嵌 API 的地址、会话 cookie、/playmode/intelligence/list。
// 宿主自己的 transport 不对外开放，这里复刻它的两件事：端口从 window.electron 取，
// cookie 从渲染端 localStorage 取（Folia 存在 online_provider:netease:cookie）。

const LOGIN_COOKIE_KEYS = ['online_provider:netease:cookie', 'netease_cookie'];
const ANONYMOUS_COOKIE_KEYS = ['online_provider:netease:anonymous_cookie', 'netease_anonymous_cookie'];

const readLocalStorage = (keys) => {
    if (typeof localStorage === 'undefined') return null;
    for (const key of keys) {
        try {
            const value = localStorage.getItem(key);
            if (value) return value;
        } catch {
            // 隐私设置下读 localStorage 会抛错，按没有处理。
        }
    }
    return null;
};

/** 登录 cookie 优先，退回匿名 cookie；宿主选 cookie 的顺序与此一致。 */
export const readNeteaseCookie = () => (
    readLocalStorage(LOGIN_COOKIE_KEYS) || readLocalStorage(ANONYMOUS_COOKIE_KEYS)
);

/** 桌面版内嵌后端监听的端口；网页版没有这个桥，返回 null。 */
export const resolveNeteaseBase = async () => {
    const bridge = typeof window !== 'undefined' ? window.electron : null;
    if (!bridge || typeof bridge.getNeteasePort !== 'function') return null;
    const port = await bridge.getNeteasePort();
    return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
};

/**
 * 经宿主的 net.fetch 发出（主进程代发，不受 CORS 限制）；没有这个服务时退回渲染端 fetch。
 * 本地 API 缺路由时回的是非 JSON（Express 的 404 页面），统一归一成带 code 的错误。
 */
const getJson = async (folium, url) => {
    let body;
    let status = 0;
    if (folium.net && typeof folium.net.fetch === 'function') {
        const response = await folium.net.fetch(url, { method: 'GET', timeoutMs: 15000 });
        status = response.status;
        body = response.text();
    } else {
        const response = await fetch(url, { credentials: 'include' });
        status = response.status;
        body = await response.text();
    }
    try {
        return JSON.parse(body);
    } catch {
        throw Object.assign(new Error(`后端返回的不是 JSON（HTTP ${status}）`), { code: 'no-route', status });
    }
};

/**
 * 心动模式推荐：返回网易云歌曲 id 列表。
 * count 是接口自带的参数（官方客户端也用它一次多要几首）；老后端若忽略它，
 * 调用方会按「一次一首」重试。接口不可用（老后端缺这条路由、上游风控、返回体异常）时抛错，
 * 由调用方决定要不要退回私人 FM。
 */
export const requestHeartbeatSongIds = async (folium, { seedSongId, playlistId, cookie, count = 1 }) => {
    const base = await resolveNeteaseBase();
    if (!base) throw Object.assign(new Error('找不到内嵌网易云后端的端口'), { code: 'no-backend' });

    const wanted = Math.max(1, Math.min(10, Number(count) || 1));
    const params = new URLSearchParams({
        id: String(seedSongId),
        sid: String(seedSongId),
        timestamp: String(Date.now()),
        count: String(wanted),
    });
    if (playlistId !== null && playlistId !== undefined) params.set('pid', String(playlistId));
    if (cookie) params.set('cookie', cookie);

    const payload = await getJson(folium, `${base}/playmode/intelligence/list?${params.toString()}`);
    if (Number(payload?.code) !== 200 || !Array.isArray(payload?.data)) {
        throw Object.assign(new Error(`心动模式接口返回异常（code=${payload?.code ?? 'none'}）`), { code: 'bad-response' });
    }

    return payload.data
        .map((entry) => Number(entry?.songInfo?.id ?? entry?.id))
        .filter((id) => Number.isInteger(id) && id > 0);
};
