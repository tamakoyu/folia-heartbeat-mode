// recommend.mjs — 从网易云拿「我喜欢的音乐」和推荐，只走宿主的公开接口。
//
// 会话由宿主补上：模组既看不到 cookie，也看不到网易云后端的地址。
//   - `folium.experimental['platform.raw']`（实验接口，清单里选用 `platform.raw`，权限
//     `platform.netease.read`）：以当前登录的账号调网易云后端。能调哪些接口由宿主自己的分类表决定
//     （`src/services/onlineMusic/netease/neteaseRaw.ts`）。
//   - `folium.omni.resolveSongs`：把 id 换成宿主的歌曲 DTO，带 `ref`，可以直接交给
//     `folium.playback.replaceQueue`。
//
// 推荐按三步依次退让：
//   1. `playmode_intelligence_list` —— 网易云「心动模式」本身，以种子歌为起点。宿主的只读表里还没
//      有这条路由，会被以 `endpoint-denied` 拒绝；等它加进来这里自动生效，不用改代码。
//   2. `simi_song` —— 同一颗种子的「相似歌曲」，思路最接近，表里放行。
//   3. `personal_fm` —— 账号口味的私人 FM，前两步都给不出新歌时兜底。

const PROVIDER = 'netease';
const RESOLVE_CHUNK = 50;
const PERSONAL_FM_TRIES = 3;
const SIMILAR_LIMIT = 50;

/** 网易云各种「数组里套着歌」的形状，取出 id 字符串数组。 */
const idsFrom = (value) => (Array.isArray(value) ? value : []).map((entry) => {
    if (entry === null || entry === undefined) return null;
    if (typeof entry === 'object') {
        const id = entry.songInfo?.id ?? entry.id ?? entry.songId ?? null;
        return id === null || id === undefined ? null : String(id);
    }
    return String(entry);
}).filter((id) => id !== null && id !== '');

const toSongKey = (song) => `${song?.source ?? ''}\u0000${song?.id ?? ''}`;

/**
 * @param {object} options
 * @param {object} options.folium 宿主的 folium 全局
 * @param {(message: string, detail?: unknown) => void} [options.log] 开发者日志
 */
export const createSource = ({ folium, log = () => {} }) => {
    const omni = folium.omni;
    const platform = folium.experimental?.['platform.raw'] ?? null;
    let likedIdsCache = null;
    let heartbeatRefused = false;

    /** 宿主代发一次平台请求，返回平台的原始 JSON。 */
    const raw = async (endpoint, params = {}, signal) => {
        if (!platform) throw Object.assign(new Error('platform.raw is not available'), { code: 'unsupported' });
        const answer = await platform.request(PROVIDER, endpoint, params, signal ? { signal } : undefined);
        return answer?.body;
    };

    /** 所有「我喜欢的音乐」的歌曲 id，一次给全（无序）。 */
    const likedIds = async (signal) => {
        if (likedIdsCache) return likedIdsCache;
        const body = await raw('likelist', {}, signal);
        const ids = idsFrom(body?.ids ?? body?.data?.ids ?? body?.data);
        likedIdsCache = ids;
        return ids;
    };

    /** 一批 id → 歌曲 DTO（认不出的丢掉）。 */
    const songsByIds = async (ids, signal) => {
        const keys = (Array.isArray(ids) ? ids : [])
            .filter((id) => id !== null && id !== undefined && id !== '')
            .map((id) => ({ source: PROVIDER, id: String(id) }));
        if (keys.length === 0) return [];
        const songs = [];
        for (let at = 0; at < keys.length; at += RESOLVE_CHUNK) {
            const answers = await omni.resolveSongs(keys.slice(at, at + RESOLVE_CHUNK), signal ? { signal } : undefined);
            for (const answer of answers) {
                if (answer?.status === 'found' && answer.song) songs.push(answer.song);
            }
        }
        return songs;
    };

    /** 心动模式本身：以 `seedId` 为种子。表里没有这条路由时以 `endpoint-denied` 失败。 */
    const heartbeat = async (seedId, want, signal) => {
        const body = await raw('playmode_intelligence_list', { id: seedId, count: want }, signal);
        const ids = idsFrom(body?.data ?? body?.data?.data);
        return songsByIds(ids.slice(0, want * 2), signal);
    };

    /** 相似歌曲：同一颗种子，换一条宿主放行的路。 */
    const similar = async (seedId, want, signal) => {
        const body = await raw('simi_song', { id: seedId, limit: SIMILAR_LIMIT }, signal);
        const ids = idsFrom(body?.songs ?? body?.data);
        return songsByIds(ids.slice(0, want * 3), signal);
    };

    /** 私人 FM：账号口味兜底，一次通常只给一首。 */
    const personalFm = async (want, signal) => {
        const songs = [];
        for (let round = 0; round < PERSONAL_FM_TRIES && songs.length < want; round += 1) {
            const body = await raw('personal_fm', {}, signal);
            const ids = idsFrom(body?.data ?? body?.data?.data);
            if (ids.length === 0) break;
            songs.push(...await songsByIds(ids, signal));
        }
        return songs.slice(0, want);
    };

    return {
        likedIds,
        songsByIds,
        /**
         * 以 `seedId` 为种子要 `want` 首推荐，`exclude`（key 的 Set）里的不要。
         * 返回 `{ songs, via }`；一首都要不到时 `songs` 为空、`via` 为 null。
         */
        recommend: async (seedId, want, exclude, signal) => {
            const fresh = (songs) => songs.filter((song) => !exclude.has(toSongKey(song)));
            const steps = [];
            if (!heartbeatRefused) steps.push(['heartbeat', () => heartbeat(seedId, want, signal), true]);
            steps.push(['similar', () => similar(seedId, want, signal), false]);
            steps.push(['personal-fm', () => personalFm(want, signal), false]);
            for (const [via, run, canDeny] of steps) {
                try {
                    const picked = fresh(await run());
                    if (picked.length > 0) return { songs: picked.slice(0, want), via };
                } catch (error) {
                    const code = error?.code ?? null;
                    if (code === 'aborted') throw error;
                    // 心动接口还不在宿主的表里：说一次就够，之后别再试，免得日志里全是它。
                    if (canDeny && code === 'endpoint-denied') {
                        heartbeatRefused = true;
                        log('心动接口还没开放（endpoint-denied），改用相似歌曲与私人 FM');
                        continue;
                    }
                    log(`${via} failed: ${code ?? error?.message ?? String(error)}`);
                }
            }
            return { songs: [], via: null };
        },
        /** 宿主的公开接口是否可用（老宿主没有 platform.raw）。 */
        get available() {
            return Boolean(platform) && typeof omni?.resolveSongs === 'function';
        },
    };
};